// VibesByVince — Worker entry point.
//
// This project deploys via Cloudflare Workers (with static assets), not
// classic Pages, so routing works a little differently than a Pages
// Functions `/functions` folder would. `wrangler.jsonc` sets
// `run_worker_first: ["/api/*"]`, which means every request EXCEPT ones
// starting with /api/ is served directly from the static files and never
// even reaches this script. Only /api/* traffic runs the code below.

const CHANNEL_ID = 'UCyqkH9sniDc1bEQwDcpky9w';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/youtube') {
      return handleYoutube();
    }

    if (url.pathname === '/api/schedule') {
      return handleSchedule(env);
    }

    // Fallback safety net — shouldn't normally be reached given
    // run_worker_first is scoped to /api/*.
    return env.ASSETS.fetch(request);
  },
};

async function handleYoutube() {
  try {
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
    const feedRes = await fetch(feedUrl, {
      cf: { cacheTtl: 1800, cacheEverything: true },
    });

    if (!feedRes.ok) {
      throw new Error(`feed fetch failed: ${feedRes.status}`);
    }

    const xml = await feedRes.text();
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
    if (!entryMatch) throw new Error('no entries in feed');

    const entry = entryMatch[1];
    const videoId = firstMatch(entry, /<yt:videoId>(.*?)<\/yt:videoId>/);
    const title = firstMatch(entry, /<media:title>(.*?)<\/media:title>/) || firstMatch(entry, /<title>(.*?)<\/title>/);
    const thumbnail = firstMatch(entry, /<media:thumbnail url="(.*?)"/);

    if (!videoId) throw new Error('no video id found');

    const data = {
      id: videoId,
      title: decodeXmlEntities(title || 'watch latest video'),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };

    return json(data, 200, 'public, max-age=600, s-maxage=1800');
  } catch (err) {
    return json({ error: true, message: String(err) }, 200, 'public, max-age=60');
  }
}

// ---------- /api/schedule ----------
//
// Reads a public Google Calendar (iCal/ICS feed) server-side and returns
// the next upcoming event as { next, game }. The feed URL is NOT stored
// in this file or in git — it's read from env.CALENDAR_ICS_URL, a
// Cloudflare secret set in the dashboard (Settings/Bindings for this
// Worker). That keeps the calendar's address out of the public repo.
//
// Display is always formatted in America/Phoenix time, since that's
// where the schedule is actually run from. Parsing assumes any event
// time WITHOUT a "Z" (UTC) suffix is already in America/Phoenix local
// time (which has no DST, so this is a safe fixed -7:00 offset) unless
// Google's export marks it UTC directly.

async function handleSchedule(env) {
  try {
    const icsUrl = env.CALENDAR_ICS_URL;
    if (!icsUrl) throw new Error('CALENDAR_ICS_URL is not configured');

    const res = await fetch(icsUrl, {
      cf: { cacheTtl: 900, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`ics fetch failed: ${res.status}`);

    const icsText = await res.text();
    const events = parseIcsEvents(icsText);

    const now = Date.now();
    const upcoming = events
      .filter((e) => e.date && e.date.getTime() > now)
      .sort((a, b) => a.date - b.date);

    if (upcoming.length === 0) {
      return json({ next: null, game: null }, 200, 'public, max-age=300, s-maxage=600');
    }

    const nextEvent = upcoming[0];
    const formatted = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Phoenix',
      timeZoneName: 'short',
    }).format(nextEvent.date);

    return json(
      { next: formatted, game: nextEvent.summary || null },
      200,
      'public, max-age=300, s-maxage=600'
    );
  } catch (err) {
    return json({ error: true, message: String(err) }, 200, 'public, max-age=60');
  }
}

function parseIcsEvents(icsText) {
  // Unfold ICS line continuations (a line starting with a space/tab is a
  // continuation of the previous line) before splitting into lines.
  const unfolded = icsText.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);

    if (key === 'SUMMARY') current.summary = unescapeIcsText(value);
    if (key === 'DTSTART' || key.startsWith('DTSTART;')) {
      current.date = parseIcsDate(value);
    }
  }

  return events;
}

function parseIcsDate(raw) {
  // Matches e.g. 20260908T170000Z or 20260908T170000
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;

  const [, y, mo, d, h, mi, s, z] = m;
  const y_ = +y, mo_ = +mo - 1, d_ = +d, h_ = +h, mi_ = +mi, s_ = +s;

  if (z === 'Z') {
    return new Date(Date.UTC(y_, mo_, d_, h_, mi_, s_));
  }

  // No explicit UTC marker — treat as America/Phoenix local time (fixed
  // UTC-7, no DST).
  return new Date(Date.UTC(y_, mo_, d_, h_, mi_, s_) + 7 * 60 * 60 * 1000);
}

function unescapeIcsText(str) {
  return str
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function firstMatch(str, regex) {
  const m = str.match(regex);
  return m ? m[1] : null;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function json(data, status, cacheControl) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': cacheControl,
    },
  });
}
