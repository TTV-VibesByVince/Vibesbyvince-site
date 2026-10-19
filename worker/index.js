// VibesByVince — Worker entry point.
//
// This project deploys via Cloudflare Workers (with static assets), not
// classic Pages, so routing works a little differently than a Pages
// Functions `/functions` folder would. `wrangler.jsonc` sets
// `run_worker_first: ["/api/*"]`, which means every request EXCEPT ones
// starting with /api/ is served directly from the static files and never
// even reaches this script. Only /api/* traffic runs the code below.

import { handleFortnite } from './fortnite.js';
import { handleCalendar, nextStream } from './calendar.js';
import { handleStreamTeams } from './streamteams.js';
import { handleClip } from './clip.js';

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

    if (url.pathname === '/api/clip') {
      return handleClip(request, env);
    }

    if (url.pathname === '/api/tiktok') {
      return handleTiktok(request, env);
    }

    if (url.pathname === '/api/projects') {
      return handleProjects();
    }

    if (url.pathname.startsWith('/api/project-image/')) {
      return handleProjectImage(url.pathname.slice('/api/project-image/'.length));
    }

    // Fortnite Hub (/fortnite) — see worker/fortnite.js
    if (url.pathname.startsWith('/api/fortnite/')) {
      return handleFortnite(request, env, url);
    }

    // Stream teams raid finder (/streamteams) — see worker/streamteams.js
    if (url.pathname === '/api/streamteams' || url.pathname.startsWith('/api/streamteams/')) {
      return handleStreamTeams(request, env, url);
    }

    // Stream calendar (/calendar, /calendar/admin) — see worker/calendar.js
    if (url.pathname === '/api/calendar' || url.pathname.startsWith('/api/calendar/')) {
      return handleCalendar(request, env, url);
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

// ---------- /api/projects + /api/project-image/<repo> ----------
//
// The Vibes Lab cards show each repo's own GitHub description and social
// preview image, so editing them on GitHub updates the site too (within
// ~6 hours, the cache time). Both come from the repo's public GitHub page
// (its <meta> tags), which needs no API key and isn't subject to the
// 60-requests-an-hour limit of GitHub's unauthenticated API.
//
// Images are passed through this Worker rather than linked directly, so
// visitors' browsers never contact GitHub. Only the repos listed below can
// be looked up — the route can't be used to fetch anything else.

const GITHUB_OWNER = 'TTV-VibesByVince';
const PROJECT_REPOS = ['Govee-Lights-Controller', 'Vibes-TV'];
const PROJECT_IMAGE_HOSTS = ['repository-images.githubusercontent.com', 'opengraph.githubassets.com'];
const PROJECT_CACHE_SECONDS = 6 * 60 * 60;

async function fetchRepoMeta(repo) {
  const pageUrl = `https://github.com/${GITHUB_OWNER}/${repo}`;
  const res = await fetch(pageUrl, {
    headers: { 'user-agent': 'vibesbyvince.com (+https://vibesbyvince.com)' },
    cf: { cacheTtl: PROJECT_CACHE_SECONDS, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`${repo}: ${res.status}`);
  const html = await res.text();

  const meta = (attr, name) => {
    const re = new RegExp(`<meta[^>]+${attr}="${name}"[^>]+content="([^"]*)"`, 'i');
    const m = html.match(re);
    return m ? decodeXmlEntities(m[1]) : null;
  };

  // GitHub's description tag reads "<repo description> - owner/repo".
  let description = meta('name', 'description') || '';
  const suffix = ` - ${GITHUB_OWNER}/${repo}`;
  if (description.endsWith(suffix)) description = description.slice(0, -suffix.length);

  const image = meta('property', 'og:image');
  let imageOk = false;
  try {
    imageOk = !!image && PROJECT_IMAGE_HOSTS.includes(new URL(image).hostname);
  } catch {
    imageOk = false;
  }

  return { repo, url: pageUrl, description: description.trim(), image: imageOk ? image : null };
}

async function handleProjects() {
  const results = await Promise.allSettled(PROJECT_REPOS.map(fetchRepoMeta));
  const projects = results
    .filter((r) => r.status === 'fulfilled')
    .map(({ value }) => ({
      repo: value.repo,
      url: value.url,
      description: value.description,
      image: value.image ? `/api/project-image/${value.repo}` : null,
    }));
  return json({ projects }, 200, `public, max-age=3600, s-maxage=${PROJECT_CACHE_SECONDS}`);
}

async function handleProjectImage(repo) {
  if (!PROJECT_REPOS.includes(repo)) {
    return new Response('not found', { status: 404 });
  }
  try {
    const { image } = await fetchRepoMeta(repo);
    if (!image) throw new Error('no preview image');

    const imgRes = await fetch(image, {
      cf: { cacheTtl: PROJECT_CACHE_SECONDS, cacheEverything: true },
    });
    const type = imgRes.headers.get('content-type') || '';
    if (!imgRes.ok || !type.startsWith('image/')) throw new Error('image fetch failed');

    return new Response(imgRes.body, {
      status: 200,
      headers: {
        'content-type': type,
        'cache-control': `public, max-age=86400, s-maxage=${PROJECT_CACHE_SECONDS}`,
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return new Response('not found', { status: 404, headers: { 'cache-control': 'public, max-age=300' } });
  }
}

// ---------- /api/tiktok ----------
//
// TikTok has no free keyless "latest video" feed, so the video is picked
// by hand: paste its link into data/latest-tiktok.json. This route reads
// that file from the static assets, then asks TikTok's public oEmbed
// endpoint (no key needed) for the caption and cover image. The cover
// URL TikTok returns is signed and expires, which is why it's looked up
// here (cached ~1h) instead of being stored in the JSON file.

async function handleTiktok(request, env) {
  try {
    const fileRes = await env.ASSETS.fetch(new URL('/data/latest-tiktok.json', request.url));
    if (!fileRes.ok) throw new Error(`latest-tiktok.json: ${fileRes.status}`);
    const file = await fileRes.json();

    const videoUrl = typeof file.url === 'string' ? file.url.trim() : '';
    if (!/^https:\/\/(www\.)?tiktok\.com\/@[\w.]+\/video\/\d+/.test(videoUrl)) {
      throw new Error('no TikTok video link set in data/latest-tiktok.json');
    }

    let title = file.caption || '';
    let thumbnail = null;
    try {
      const oembedRes = await fetch(
        `https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`,
        { cf: { cacheTtl: 3600, cacheEverything: true } }
      );
      if (oembedRes.ok) {
        const o = await oembedRes.json();
        if (!title && o.title) title = o.title;
        if (typeof o.thumbnail_url === 'string' && o.thumbnail_url.startsWith('https://')) {
          thumbnail = o.thumbnail_url;
        }
      }
    } catch {
      // oEmbed down — still return the link and caption from the file.
    }

    return json(
      { url: videoUrl, title: title || 'watch latest tiktok', thumbnail },
      200,
      'public, max-age=600, s-maxage=3600'
    );
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
  // The site's own calendar (/calendar) comes first. Until it has any
  // streams in it, the old Google Calendar feed below is still used.
  try {
    const own = await nextStream(env);
    if (own) return json(own, 200, 'public, max-age=60');
  } catch {
    // fall through to Google Calendar
  }

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
