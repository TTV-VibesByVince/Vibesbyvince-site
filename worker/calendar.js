// VibesByVince — stream schedule (/calendar) and its admin (/calendar/admin).
//
// Storage: Cloudflare D1 (binding `DB`). Tables are created automatically
// the first time they're needed, so there is no migration step.
//
// Public routes (anyone):
//   GET  /api/calendar?from=…&to=…     streams in a date range (max ~62 days)
//   GET  /api/calendar/ics              subscribe feed for calendar apps
//
// Admin routes (/api/calendar/admin/*) — Vince only:
//   Cloudflare Access sits in front of /calendar/admin and
//   /api/calendar/admin, and this file ALSO checks Access's signed login
//   token and the email inside it on every request (see requireAdmin), so
//   a mistake in the Access settings can't open the admin API to anyone.
//
// Twitch sync: every stream saved here is copied to the Twitch schedule
// (see worker/twitch.js). Only "Manage your schedule" access is requested.
//
// Times: Vince enters Arizona time (America/Phoenix, always UTC-7, no
// daylight saving). Everything is stored in UTC.

import { twitch } from './twitch.js';

const PHOENIX_OFFSET_MIN = -7 * 60;
const MAX_RANGE_DAYS = 62;
const MAX_REPEAT_WEEKS = 12;
const TAGS = ['fortnite', 'horror', 'variety', 'special'];

// ---------- database ----------

let schemaReady = false;

export async function db(env) {
  if (!env.DB) return null;
  if (!schemaReady) {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_utc TEXT NOT NULL,
        duration_min INTEGER NOT NULL,
        title TEXT NOT NULL,
        category_id TEXT,
        category_name TEXT,
        tag TEXT NOT NULL DEFAULT 'variety',
        twitch_segment_id TEXT,
        twitch_status TEXT NOT NULL DEFAULT 'pending',
        twitch_error TEXT,
        source TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_utc)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    ]);
    schemaReady = true;
  }
  return env.DB;
}

// ---------- routing ----------

export async function handleCalendar(request, env, url) {
  const path = url.pathname;

  try {
    if (path === '/api/calendar' && request.method === 'GET') return await publicRange(env, url);
    if (path === '/api/calendar/ics' && request.method === 'GET') return await icsFeed(env);

    if (path.startsWith('/api/calendar/admin/')) {
      const admin = await requireAdmin(request, env);
      if (admin instanceof Response) return admin;
      return await adminRoute(request, env, url, admin);
    }

    return json({ error: 'not_found' }, 404);
  } catch (err) {
    return json({ error: 'server_error', message: String(err && err.message ? err.message : err) }, 500);
  }
}

// ---------- public ----------

function publicEvent(r) {
  return {
    id: r.id,
    start: r.start_utc,
    durationMin: r.duration_min,
    title: r.title,
    category: r.category_name || null,
    tag: r.tag,
  };
}

async function publicRange(env, url) {
  const d = await db(env);
  if (!d) return json({ events: [], configured: false }, 200, 'public, max-age=60');

  const from = parseIso(url.searchParams.get('from')) || new Date(Date.now() - 7 * 86400000);
  let to = parseIso(url.searchParams.get('to')) || new Date(from.getTime() + 35 * 86400000);
  if (to - from > MAX_RANGE_DAYS * 86400000) to = new Date(from.getTime() + MAX_RANGE_DAYS * 86400000);

  const { results } = await d
    .prepare('SELECT * FROM events WHERE start_utc >= ? AND start_utc < ? ORDER BY start_utc LIMIT 300')
    .bind(from.toISOString(), to.toISOString())
    .all();
  return json({ events: results.map(publicEvent), configured: true }, 200, 'public, max-age=60');
}

// Used by /api/schedule (homepage card, Fortnite banner). Returns null when
// the calendar isn't set up yet, so the old Google Calendar path is used.
export async function nextStream(env) {
  const d = await db(env);
  if (!d) return null;
  const nowIso = new Date().toISOString();
  // a stream that's currently scheduled to be on still counts until it ends
  const row = await d
    .prepare(
      "SELECT * FROM events WHERE datetime(start_utc, '+' || duration_min || ' minutes') > datetime(?) ORDER BY start_utc LIMIT 1"
    )
    .bind(nowIso)
    .first();
  if (!row) {
    const any = await d.prepare('SELECT COUNT(*) AS n FROM events').first();
    return any && any.n > 0 ? { next: null, game: null } : null;
  }
  return { next: formatPhoenix(new Date(row.start_utc)), game: row.title };
}

async function icsFeed(env) {
  const d = await db(env);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//vibesbyvince.com//Stream Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:VibesByVince streams',
    'X-WR-TIMEZONE:America/Phoenix',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  if (d) {
    const from = new Date(Date.now() - 30 * 86400000).toISOString();
    const to = new Date(Date.now() + 90 * 86400000).toISOString();
    const { results } = await d
      .prepare('SELECT * FROM events WHERE start_utc >= ? AND start_utc < ? ORDER BY start_utc')
      .bind(from, to)
      .all();
    const stamp = icsDate(new Date());
    for (const r of results) {
      const start = new Date(r.start_utc);
      const end = new Date(start.getTime() + r.duration_min * 60000);
      lines.push(
        'BEGIN:VEVENT',
        `UID:stream-${r.id}@vibesbyvince.com`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${icsDate(start)}`,
        `DTEND:${icsDate(end)}`,
        fold(`SUMMARY:${icsText(r.title)}`),
        fold(`DESCRIPTION:${icsText((r.category_name ? r.category_name + ' · ' : '') + 'Live on twitch.tv/vibesbyvince')}`),
        'URL:https://twitch.tv/vibesbyvince',
        'LOCATION:https://twitch.tv/vibesbyvince',
        'END:VEVENT'
      );
    }
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="vibesbyvince.ics"',
      'cache-control': 'public, max-age=900',
    },
  });
}

// ---------- admin login check ----------
// Cloudflare Access adds a signed token (JWT) to every request it lets
// through. We verify its signature against Access's public keys, its
// audience (ACCESS_AUD), issuer (ACCESS_TEAM_DOMAIN), expiry, and that the
// email is ADMIN_EMAIL. If any of those secrets are missing, admin is
// closed — never open.

let jwksCache = { at: 0, keys: null, domain: null };

async function requireAdmin(request, env) {
  const url = new URL(request.url);

  // Local testing only: `wrangler dev` on this computer with
  // DEV_ADMIN_BYPASS=true in .dev.vars (a git-ignored file).
  const isLocal = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (isLocal && env.DEV_ADMIN_BYPASS === 'true') return { email: 'local-dev' };

  // Block cross-site form posts: changes must come from this site's own pages.
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    if (!origin || origin !== url.origin) return json({ error: 'bad_origin' }, 403);
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ADMIN_EMAIL) {
    return json({ error: 'admin_not_configured' }, 503);
  }

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return json({ error: 'not_signed_in' }, 401);

  try {
    const claims = await verifyAccessJwt(token, env);
    const email = String(claims.email || '').toLowerCase();
    const allowed = String(env.ADMIN_EMAIL)
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowed.includes(email)) return json({ error: 'not_allowed' }, 403);
    return { email };
  } catch {
    return json({ error: 'not_signed_in' }, 401);
  }
}

async function verifyAccessJwt(token, env) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new Error('bad token');
  const header = JSON.parse(b64urlText(h));
  const claims = JSON.parse(b64urlText(p));
  if (header.alg !== 'RS256') throw new Error('bad alg');

  const domain = String(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const issuer = `https://${domain}`;
  if (claims.iss !== issuer) throw new Error('bad issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new Error('bad audience');
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp < now - 30) throw new Error('expired');
  if (claims.nbf && claims.nbf > now + 30) throw new Error('not yet valid');

  if (!jwksCache.keys || jwksCache.domain !== domain || Date.now() - jwksCache.at > 3600000) {
    const res = await fetch(`${issuer}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error('certs');
    jwksCache = { at: Date.now(), keys: (await res.json()).keys || [], domain };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('bad signature');
  return claims;
}

// ---------- admin routes ----------

async function adminRoute(request, env, url, admin) {
  const d = await db(env);
  if (!d) return json({ error: 'db_not_configured' }, 503);

  const sub = url.pathname.slice('/api/calendar/admin/'.length);
  const method = request.method;

  if (sub === 'status' && method === 'GET') {
    const tw = await twitch.status(env, d);
    const counts = await d
      .prepare(
        "SELECT SUM(CASE WHEN start_utc >= ? THEN 1 ELSE 0 END) AS upcoming, SUM(CASE WHEN twitch_status = 'error' AND start_utc >= ? THEN 1 ELSE 0 END) AS errors FROM events"
      )
      .bind(new Date().toISOString(), new Date().toISOString())
      .first();
    const imported = await getSetting(d, 'imported_at');
    return json({ email: admin.email, twitch: tw, upcoming: counts.upcoming || 0, errors: counts.errors || 0, importedAt: imported });
  }

  if (sub === 'events' && method === 'GET') {
    const when = url.searchParams.get('when') === 'past' ? 'past' : 'upcoming';
    const nowIso = new Date().toISOString();
    const q =
      when === 'past'
        ? d.prepare('SELECT * FROM events WHERE start_utc < ? ORDER BY start_utc DESC LIMIT 100').bind(nowIso)
        : d.prepare('SELECT * FROM events WHERE start_utc >= ? ORDER BY start_utc LIMIT 200').bind(nowIso);
    const { results } = await q.all();
    return json({ events: results.map(adminEvent) });
  }

  if (sub === 'events' && method === 'POST') {
    const body = await readJson(request);
    const base = validateEvent(body);
    if (base.error) return json(base, 400);
    const weeks = Math.min(MAX_REPEAT_WEEKS, Math.max(1, parseInt(body.repeatWeeks, 10) || 1));

    const created = [];
    for (let w = 0; w < weeks; w++) {
      const start = new Date(new Date(base.start).getTime() + w * 7 * 86400000).toISOString();
      const row = await insertEvent(d, { ...base, start, source: 'admin' });
      await twitch.syncEvent(env, d, row);
      created.push(adminEvent(await getEvent(d, row.id)));
    }
    return json({ events: created });
  }

  const m = /^events\/(\d+)(\/sync)?$/.exec(sub);
  if (m) {
    const id = parseInt(m[1], 10);
    const row = await getEvent(d, id);
    if (!row) return json({ error: 'not_found' }, 404);

    if (m[2] && method === 'POST') {
      await twitch.syncEvent(env, d, row);
      return json({ event: adminEvent(await getEvent(d, id)) });
    }

    if (!m[2] && method === 'PUT') {
      const body = await readJson(request);
      const v = validateEvent(body);
      if (v.error) return json(v, 400);
      await d
        .prepare(
          'UPDATE events SET start_utc = ?, duration_min = ?, title = ?, category_id = ?, category_name = ?, tag = ?, updated_at = ? WHERE id = ?'
        )
        .bind(v.start, v.durationMin, v.title, v.categoryId, v.categoryName, v.tag, new Date().toISOString(), id)
        .run();
      await twitch.syncEvent(env, d, await getEvent(d, id));
      return json({ event: adminEvent(await getEvent(d, id)) });
    }

    if (!m[2] && method === 'DELETE') {
      const res = await twitch.removeEvent(env, d, row);
      if (!res.ok) return json({ error: 'twitch_delete_failed', message: res.error }, 502);
      await d.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }

  if (sub === 'categories' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return json({ categories: [] });
    return json({ categories: await twitch.searchCategories(env, d, q) });
  }

  if (sub === 'twitch/connect' && method === 'GET') return twitch.connect(request, env, d);
  if (sub === 'twitch/callback' && method === 'GET') return twitch.callback(request, env, d, url);
  if (sub === 'twitch/disconnect' && method === 'POST') {
    await twitch.disconnect(env, d);
    return json({ ok: true });
  }

  if (sub === 'import' && method === 'POST') {
    const result = await importAll(env, d);
    return json(result);
  }

  return json({ error: 'not_found' }, 404);
}

function adminEvent(r) {
  return {
    id: r.id,
    start: r.start_utc,
    durationMin: r.duration_min,
    title: r.title,
    categoryId: r.category_id,
    categoryName: r.category_name,
    tag: r.tag,
    twitchStatus: r.twitch_status,
    twitchError: r.twitch_error,
    source: r.source,
  };
}

// Turns the admin form (Arizona date + time) into a stored event.
function validateEvent(b) {
  if (!b || typeof b !== 'object') return { error: 'bad_request' };
  const title = String(b.title || '').trim();
  if (!title) return { error: 'title_required' };
  if (title.length > 140) return { error: 'title_too_long' };

  const date = String(b.date || '');
  const time = String(b.time || '');
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dm || !tm) return { error: 'bad_date' };
  const utcMs = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]) - PHOENIX_OFFSET_MIN * 60000;
  if (Number.isNaN(utcMs)) return { error: 'bad_date' };

  const durationMin = parseInt(b.durationMin, 10);
  if (!(durationMin >= 30 && durationMin <= 1380)) return { error: 'bad_duration' };

  const tag = TAGS.includes(b.tag) ? b.tag : guessTag(b.categoryName);
  const categoryId = b.categoryId ? String(b.categoryId).slice(0, 32) : null;
  const categoryName = b.categoryName ? String(b.categoryName).slice(0, 120) : null;

  return { start: new Date(utcMs).toISOString(), durationMin, title, categoryId, categoryName, tag };
}

export function guessTag(categoryName) {
  const c = String(categoryName || '').toLowerCase();
  if (c.includes('fortnite')) return 'fortnite';
  if (/(phasmophobia|dead by daylight|horror|resident evil|outlast|lethal company|five nights|silent hill|fnaf|dead space|alien|the forest|sons of the forest|until dawn|the quarry|devour|amnesia|layers of fear)/.test(c)) return 'horror';
  return 'variety';
}

export async function insertEvent(d, e) {
  const now = new Date().toISOString();
  const res = await d
    .prepare(
      'INSERT INTO events (start_utc, duration_min, title, category_id, category_name, tag, twitch_segment_id, twitch_status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *'
    )
    .bind(
      e.start,
      e.durationMin,
      e.title,
      e.categoryId || null,
      e.categoryName || null,
      e.tag || guessTag(e.categoryName),
      e.twitchSegmentId || null,
      e.twitchStatus || 'pending',
      e.source || 'admin',
      now,
      now
    )
    .first();
  return res;
}

export async function getEvent(d, id) {
  return d.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
}

export async function getSetting(d, key) {
  const row = await d.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

export async function setSetting(d, key, value) {
  if (value === null || value === undefined) {
    await d.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
  } else {
    await d.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value)).run();
  }
}

// ---------- one-time import (Google Calendar + Twitch schedule) ----------
// Upcoming streams from both are copied in. Anything starting within 30
// minutes of a stream already here counts as the same stream. Repeating
// Twitch entries become one entry per week (next 8 weeks) and the
// repeating series on Twitch is replaced by individual entries.

async function importAll(env, d) {
  const now = Date.now();
  const existing = (await d.prepare('SELECT start_utc FROM events WHERE start_utc >= ?').bind(new Date(now).toISOString()).all()).results.map((r) =>
    Date.parse(r.start_utc)
  );
  const isDup = (ms) => existing.some((t) => Math.abs(t - ms) < 30 * 60000);

  let fromGoogle = 0;
  let fromTwitch = 0;
  const notes = [];

  // Twitch first: it has categories and lengths.
  const tw = await twitch.importSchedule(env, d, { weeks: 8 });
  if (tw.error) notes.push(`Twitch: ${tw.error}`);
  let weeklyFailed = 0;
  for (const s of tw.segments || []) {
    const ms = Date.parse(s.start);
    if (ms <= now || isDup(ms)) continue;
    const row = await insertEvent(d, {
      start: new Date(ms).toISOString(),
      durationMin: s.durationMin,
      title: (s.title || s.categoryName || 'Stream').slice(0, 140),
      categoryId: s.categoryId,
      categoryName: s.categoryName,
      tag: guessTag(s.categoryName),
      twitchSegmentId: s.keepSegmentId || null,
      twitchStatus: s.keepSegmentId ? 'ok' : 'pending',
      source: 'twitch',
    });
    existing.push(ms);
    fromTwitch++;
    if (!s.keepSegmentId) {
      await twitch.syncEvent(env, d, row);
      const after = await getEvent(d, row.id);
      if (after.twitch_status !== 'ok') weeklyFailed++;
    }
  }

  // Only now swap Twitch's repeating series for the individual weeks.
  let replacedRecurring = 0;
  const seriesIds = tw.recurringSeriesIds || [];
  if (seriesIds.length && weeklyFailed === 0) {
    replacedRecurring = await twitch.deleteSeries(env, d, seriesIds);
  } else if (seriesIds.length) {
    notes.push(
      `Your repeating Twitch entries were kept, because ${weeklyFailed} weekly ${weeklyFailed === 1 ? 'entry' : 'entries'} couldn't be added to Twitch. Fix those (Retry), then run the import again.`
    );
  }

  // Google Calendar (the old setup), if its secret is still there.
  if (env.CALENDAR_ICS_URL) {
    try {
      const res = await fetch(env.CALENDAR_ICS_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const events = parseIcs(await res.text());
      for (const e of events) {
        const ms = e.start.getTime();
        if (ms <= now || isDup(ms)) continue;
        const durationMin = Math.min(1380, Math.max(30, e.end ? Math.round((e.end - e.start) / 60000) : 180));
        const row = await insertEvent(d, {
          start: e.start.toISOString(),
          durationMin,
          title: (e.summary || 'Stream').slice(0, 140),
          tag: guessTag(e.summary),
          source: 'google',
        });
        existing.push(ms);
        fromGoogle++;
        await twitch.syncEvent(env, d, row);
      }
    } catch (err) {
      notes.push(`Google Calendar: ${String(err.message || err)}`);
    }
  }

  await setSetting(d, 'imported_at', new Date().toISOString());
  return { fromTwitch, fromGoogle, replacedRecurring, notes };
}

// Minimal iCal reader for the Google import (same rules as the old
// /api/schedule: no "Z" means Arizona time).
function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') {
      if (cur && cur.start) out.push(cur);
      cur = null;
    } else if (cur) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i);
      const val = line.slice(i + 1);
      if (key === 'SUMMARY') cur.summary = val.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
      if (key === 'DTSTART' || key.startsWith('DTSTART;')) cur.start = icsParse(val);
      if (key === 'DTEND' || key.startsWith('DTEND;')) cur.end = icsParse(val);
    }
  }
  return out;
}

function icsParse(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return new Date(m[7] ? ms : ms - PHOENIX_OFFSET_MIN * 60000);
}

// ---------- helpers ----------

export function formatPhoenix(date) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Phoenix',
    timeZoneName: 'short',
  }).format(date);
}

function parseIso(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

function icsDate(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function fold(line) {
  // iCal lines should be at most 75 octets; continuation lines start with a space
  const out = [];
  let rest = line;
  while (new TextEncoder().encode(rest).length > 73) {
    let cut = 73;
    while (new TextEncoder().encode(rest.slice(0, cut)).length > 73) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlText(s) {
  return new TextDecoder().decode(b64urlBytes(s));
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function json(data, status = 200, cacheControl = 'no-store') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': cacheControl },
  });
}
