// VibesByVince — Vibesmas Tournament (/vibesmas).
//
// Public:
//   GET    /api/vibesmas                 roster, published scores, phase
//   POST   /api/vibesmas/signup          a duo signs up (waits for approval)
//   GET    /api/vibesmas/status?t=…      a duo's own sign-up, by its private key
//   PUT    /api/vibesmas/status?t=…      edit it (only while not approved)
//   DELETE /api/vibesmas/status?t=…      withdraw it
// Admin (Cloudflare Access + the same checks as the calendar admin):
//   GET    /api/vibesmas/admin/state
//   POST   /api/vibesmas/admin/duo       approve / decline / reset / delete
//   POST   /api/vibesmas/admin/scores    save or publish one game's results
//   POST   /api/vibesmas/admin/settings  phase, current game, outfit winner
//
// Each duo gets a random private key when it signs up. Only a hash of the
// key is stored, so the key in the duo's status link can't be recovered
// from the database. New sign-ups are announced in a private Discord
// channel through the VIBESMAS_DISCORD_WEBHOOK secret (optional).

import { db, requireAdmin, getSetting, setSetting, json } from './calendar.js';
import { appConfigured, appHelix } from './twitch-app.js';

export const TOURNAMENT = {
  start: '2026-12-12T17:00:00Z', // 9:00 AM PST / 10:00 AM MST
  regClose: '2026-12-06T06:59:59Z', // Sat Dec 5, 11:59:59 PM MST
  maxDuos: 40,
  games: 5,
};
const PTS = { 1: 10, 2: 8, 3: 6, 4: 4, 5: 2 };
const PHASES = ['signups', 'live', 'review', 'final'];
const SIGNUPS_PER_DAY_PER_IP = 3;
const PUBLIC_CACHE_SECONDS = 15;

// ---------- database ----------

let ready = false;

async function vdb(env) {
  const d = await db(env); // also creates the shared settings table
  if (!d) return null;
  if (!ready) {
    await d.batch([
      d.prepare(`CREATE TABLE IF NOT EXISTS vibesmas_duos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT,
        streams TEXT NOT NULL,
        p1_epic TEXT NOT NULL, p1_twitch TEXT, p1_discord TEXT,
        p2_epic TEXT NOT NULL, p2_twitch TEXT, p2_discord TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        ip_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
      d.prepare(`CREATE TABLE IF NOT EXISTS vibesmas_scores (
        game INTEGER NOT NULL,
        duo_id INTEGER NOT NULL,
        placement INTEGER NOT NULL,
        kills INTEGER NOT NULL,
        PRIMARY KEY (game, duo_id)
      )`),
      d.prepare(`CREATE TABLE IF NOT EXISTS vibesmas_games (
        game INTEGER PRIMARY KEY,
        published INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`),
      d.prepare(`CREATE TABLE IF NOT EXISTS vibesmas_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        text TEXT NOT NULL
      )`),
    ]);
    ready = true;
  }
  return d;
}

// ---------- routing ----------

export async function handleVibesmas(request, env, url, ctx) {
  const path = url.pathname;
  const method = request.method;
  try {
    if (path.startsWith('/api/vibesmas/admin/')) {
      const admin = await requireAdmin(request, env);
      if (admin instanceof Response) return admin;
      const d = await vdb(env);
      if (!d) return json({ error: 'db_not_configured' }, 503);
      return await adminRoute(request, env, url, d, admin);
    }

    const d = await vdb(env);
    if (!d) return json({ error: 'db_not_configured' }, 503);

    if (path === '/api/vibesmas' && method === 'GET') return await publicState(env, d, ctx);
    if (path === '/api/vibesmas/signup' && method === 'POST') {
      const bad = sameOrigin(request, url);
      if (bad) return bad;
      return await signup(request, env, d, ctx);
    }
    if (path === '/api/vibesmas/status') {
      if (method !== 'GET') {
        const bad = sameOrigin(request, url);
        if (bad) return bad;
      }
      return await statusRoute(request, env, url, d, ctx);
    }
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    return json({ error: 'server_error', message: String(err && err.message ? err.message : err) }, 500);
  }
}

function sameOrigin(request, url) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== url.origin) return json({ error: 'bad_origin' }, 403);
  return null;
}

// ---------- helpers ----------

const nowIso = () => new Date().toISOString();

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max + 1);
}

const lower = (s) => (s ? s.toLowerCase() : s);

function regOpen(now = Date.now()) {
  return now <= Date.parse(TOURNAMENT.regClose);
}

async function log(d, actor, text) {
  await d.prepare('INSERT INTO vibesmas_log (at, actor, text) VALUES (?, ?, ?)').bind(nowIso(), actor, text).run();
}

async function approvedCount(d) {
  const r = await d.prepare("SELECT COUNT(*) AS n FROM vibesmas_duos WHERE status = 'approved'").first();
  return r ? r.n : 0;
}

// Points for one game result.
export function points(placement, kills) {
  return (PTS[placement] || 0) + kills;
}

// ---------- validation ----------

const TWITCH_RE = /^[A-Za-z0-9_]{4,25}$/;
const DISCORD_RE = /^[A-Za-z0-9_.]{2,32}$/;

function validateDuo(b) {
  if (!b || typeof b !== 'object') return { error: 'bad_request' };
  if (b.website) return { error: 'bad_request' }; // honeypot field bots fill in

  const name = clean(b.name, 32);
  if (name.length < 2) return { error: 'name_required' };
  if (name.length > 32) return { error: 'name_too_long' };

  const streams = ['p1', 'p2', 'both'].includes(b.streams) ? b.streams : null;
  if (!streams) return { error: 'streamer_required' };

  const players = [b.p1 || {}, b.p2 || {}].map((p, i) => {
    const n = i + 1;
    const epic = clean(p.epic, 16);
    const twitch = clean(p.twitch, 25).replace(/^@/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '');
    const discord = clean(p.discord, 32).replace(/^@/, '');
    return { n, epic, twitch, discord };
  });

  for (const p of players) {
    if (p.epic.length < 3 || p.epic.length > 16) return { error: 'epic_required', player: p.n };
    if (p.twitch && !TWITCH_RE.test(p.twitch)) return { error: 'twitch_invalid', player: p.n };
    if (p.discord && !DISCORD_RE.test(p.discord)) return { error: 'discord_invalid', player: p.n };
  }
  const mustStream = streams === 'both' ? [0, 1] : [streams === 'p1' ? 0 : 1];
  for (const i of mustStream) {
    if (!players[i].twitch) return { error: 'twitch_required', player: i + 1 };
  }
  if (!players[0].discord && !players[1].discord) return { error: 'discord_required' };
  if (lower(players[0].epic) === lower(players[1].epic)) return { error: 'same_player' };
  if (players[0].twitch && lower(players[0].twitch) === lower(players[1].twitch)) return { error: 'same_player' };
  if (!b.age21 || !b.streamVod || !b.rules) return { error: 'confirm_required' };

  return {
    duo: {
      name,
      streams,
      p1_epic: players[0].epic, p1_twitch: players[0].twitch || null, p1_discord: players[0].discord || null,
      p2_epic: players[1].epic, p2_twitch: players[1].twitch || null, p2_discord: players[1].discord || null,
    },
  };
}

// Duo name and players must not already be on another active sign-up.
async function checkConflicts(d, duo, exceptId = 0) {
  const { results } = await d
    .prepare("SELECT id, name, p1_epic, p2_epic, p1_twitch, p2_twitch FROM vibesmas_duos WHERE status != 'declined' AND id != ?")
    .bind(exceptId)
    .all();
  const myEpics = [lower(duo.p1_epic), lower(duo.p2_epic)];
  const myTwitch = [lower(duo.p1_twitch), lower(duo.p2_twitch)].filter(Boolean);
  for (const r of results || []) {
    if (lower(r.name) === lower(duo.name)) return { error: 'name_taken' };
    const epics = [lower(r.p1_epic), lower(r.p2_epic)];
    const twitch = [lower(r.p1_twitch), lower(r.p2_twitch)].filter(Boolean);
    for (let i = 0; i < 2; i++) {
      if (epics.includes(myEpics[i])) return { error: 'player_taken', player: i + 1 };
    }
    if (myTwitch.some((t) => twitch.includes(t))) {
      return { error: 'player_taken', player: lower(duo.p1_twitch) && twitch.includes(lower(duo.p1_twitch)) ? 1 : 2 };
    }
  }
  return null;
}

// Both Twitch names (when given) must be real channels. Skipped if the
// Twitch app keys aren't configured or Twitch is unreachable.
async function checkTwitch(env, duo) {
  if (!appConfigured(env)) return null;
  const names = [duo.p1_twitch, duo.p2_twitch].filter(Boolean);
  if (!names.length) return null;
  let found;
  try {
    const res = await appHelix(env, `/users?${names.map((n) => `login=${encodeURIComponent(n.toLowerCase())}`).join('&')}`);
    found = new Set((res.data || []).map((u) => u.login.toLowerCase()));
  } catch {
    return null;
  }
  if (duo.p1_twitch && !found.has(duo.p1_twitch.toLowerCase())) return { error: 'twitch_not_found', player: 1 };
  if (duo.p2_twitch && !found.has(duo.p2_twitch.toLowerCase())) return { error: 'twitch_not_found', player: 2 };
  return null;
}

// ---------- Discord notification ----------

function discordSafe(s) {
  return String(s || '').replace(/([\\*_~`|>#\[\]()@])/g, '\\$1');
}

function playerLine(epic, twitch, discord) {
  const bits = [`Epic **${discordSafe(epic)}**`];
  if (twitch) bits.push(`Twitch ${discordSafe(twitch)}`);
  if (discord) bits.push(`Discord ${discordSafe(discord)}`);
  return bits.join(' · ');
}

function notify(env, ctx, origin, title, duo) {
  const hook = env.VIBESMAS_DISCORD_WEBHOOK;
  if (!hook || !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(hook)) return;
  const content = [
    `🎄 **${title}: ${discordSafe(duo.name)}**`,
    `Player 1: ${playerLine(duo.p1_epic, duo.p1_twitch, duo.p1_discord)}`,
    `Player 2: ${playerLine(duo.p2_epic, duo.p2_twitch, duo.p2_discord)}`,
    `Review it: ${origin}/vibesmas/admin`,
  ].join('\n');
  const send = fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(send);
}

// ---------- public state ----------

let liveCache = { at: 0, key: '', set: new Set() };

async function liveLogins(env, logins) {
  if (!appConfigured(env) || !logins.length) return new Set();
  const key = logins.slice().sort().join(',');
  if (liveCache.key === key && Date.now() - liveCache.at < 60000) return liveCache.set;
  const set = new Set();
  try {
    for (let i = 0; i < logins.length; i += 100) {
      const chunk = logins.slice(i, i + 100);
      const res = await appHelix(env, `/streams?first=100&${chunk.map((l) => `user_login=${encodeURIComponent(l)}`).join('&')}`);
      for (const s of res.data || []) set.add(String(s.user_login).toLowerCase());
    }
  } catch {
    return liveCache.set;
  }
  liveCache = { at: Date.now(), key, set };
  return set;
}

function publicPlayers(r) {
  const streamers = r.streams === 'both' ? [1, 2] : [r.streams === 'p1' ? 1 : 2];
  return [1, 2].map((n) => {
    const twitch = r[`p${n}_twitch`];
    return {
      name: twitch || r[`p${n}_epic`],
      twitch: twitch || null,
      streams: streamers.includes(n),
    };
  });
}

// Standings from the published games only (or all saved games for admin).
function standings(duos, scores, publishedGames) {
  const rows = duos.map((r) => ({
    id: r.id,
    name: r.name,
    games: Array(TOURNAMENT.games).fill(null),
    total: 0,
    kills: 0,
  }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const s of scores) {
    if (!publishedGames.includes(s.game)) continue;
    const row = byId.get(s.duo_id);
    if (!row || s.game < 1 || s.game > TOURNAMENT.games) continue;
    const pts = points(s.placement, s.kills);
    row.games[s.game - 1] = { place: s.placement, kills: s.kills, pts };
    row.total += pts;
    row.kills += s.kills;
  }
  rows.sort((a, b) => b.total - a.total || b.kills - a.kills || a.name.localeCompare(b.name));
  let prev = null;
  rows.forEach((r, i) => {
    r.rank = prev && prev.total === r.total && prev.kills === r.kills ? prev.rank : i + 1;
    prev = r;
  });
  return rows;
}

async function readSettings(d) {
  const [phase, currentGame, outfit, reviewUntil] = await Promise.all([
    getSetting(d, 'vibesmas_phase'),
    getSetting(d, 'vibesmas_current_game'),
    getSetting(d, 'vibesmas_outfit'),
    getSetting(d, 'vibesmas_review_until'),
  ]);
  return {
    phase: PHASES.includes(phase) ? phase : 'signups',
    currentGame: currentGame ? Number(currentGame) : null,
    outfitWinner: outfit || null,
    reviewUntil: reviewUntil || null,
  };
}

async function publicState(env, d, ctx) {
  const cache = caches.default;
  const cacheKey = new Request('https://vibesbyvince.com/__cache/vibesmas/state/v1');
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const [{ results: duos }, { results: scores }, { results: games }, settings] = await Promise.all([
    d.prepare("SELECT * FROM vibesmas_duos WHERE status = 'approved' ORDER BY created_at").all(),
    d.prepare('SELECT * FROM vibesmas_scores').all(),
    d.prepare('SELECT game FROM vibesmas_games WHERE published = 1').all(),
    readSettings(d),
  ]);
  const published = (games || []).map((g) => g.game).sort((a, b) => a - b);

  const streamerLogins = [];
  for (const r of duos || []) {
    for (const p of publicPlayers(r)) if (p.streams && p.twitch) streamerLogins.push(p.twitch.toLowerCase());
  }
  const live = await liveLogins(env, streamerLogins);

  const roster = (duos || []).map((r) => {
    const players = publicPlayers(r).map((p) => ({ ...p, live: !!(p.twitch && live.has(p.twitch.toLowerCase())) }));
    return { id: r.id, name: r.name, players };
  });
  const rosterById = new Map(roster.map((r) => [r.id, r]));
  const table = standings(duos || [], scores || [], published).map((s) => ({ ...s, players: rosterById.get(s.id).players }));

  const now = Date.now();
  const body = {
    now: new Date(now).toISOString(),
    start: TOURNAMENT.start,
    regClose: TOURNAMENT.regClose,
    maxDuos: TOURNAMENT.maxDuos,
    games: TOURNAMENT.games,
    approved: roster.length,
    regOpen: regOpen(now) && roster.length < TOURNAMENT.maxDuos,
    ...settings,
    published,
    standings: table,
  };
  const res = json(body, 200, `public, max-age=${PUBLIC_CACHE_SECONDS}`);
  ctx && ctx.waitUntil && ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function purgePublic() {
  try {
    await caches.default.delete(new Request('https://vibesbyvince.com/__cache/vibesmas/state/v1'));
  } catch {}
}

// ---------- sign-up ----------

async function signup(request, env, d, ctx) {
  if (!regOpen()) return json({ error: 'registration_closed' }, 409);
  if ((await approvedCount(d)) >= TOURNAMENT.maxDuos) return json({ error: 'full' }, 409);

  const v = validateDuo(await readJson(request));
  if (v.error) return json(v, 400);
  const conflict = await checkConflicts(d, v.duo);
  if (conflict) return json(conflict, 409);
  const tw = await checkTwitch(env, v.duo);
  if (tw) return json(tw, 400);

  // A few sign-ups a day per network, to stop spam filling the queue.
  const ip = request.headers.get('cf-connecting-ip') || '';
  const ipHash = ip ? (await sha256Hex(`vibesmas:${ip}:${env.TWITCH_CLIENT_SECRET || ''}`)).slice(0, 32) : null;
  if (ipHash) {
    const since = new Date(Date.now() - 86400000).toISOString();
    const r = await d.prepare('SELECT COUNT(*) AS n FROM vibesmas_duos WHERE ip_hash = ? AND created_at > ?').bind(ipHash, since).first();
    if (r && r.n >= SIGNUPS_PER_DAY_PER_IP) return json({ error: 'too_many' }, 429);
  }

  const token = newToken();
  const t = nowIso();
  const x = v.duo;
  await d
    .prepare(`INSERT INTO vibesmas_duos (name, status, streams, p1_epic, p1_twitch, p1_discord, p2_epic, p2_twitch, p2_discord, token_hash, ip_hash, created_at, updated_at)
      VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(x.name, x.streams, x.p1_epic, x.p1_twitch, x.p1_discord, x.p2_epic, x.p2_twitch, x.p2_discord, await sha256Hex(token), ipHash, t, t)
    .run();
  await log(d, 'sign-up', `${x.name} signed up`);
  notify(env, ctx, new URL(request.url).origin, 'New Vibesmas sign-up', x);
  return json({ ok: true, token }, 201);
}

// ---------- a duo's own status page ----------

function ownView(r) {
  return {
    name: r.name,
    status: r.status,
    note: r.note || null,
    streams: r.streams,
    p1: { epic: r.p1_epic, twitch: r.p1_twitch || '', discord: r.p1_discord || '' },
    p2: { epic: r.p2_epic, twitch: r.p2_twitch || '', discord: r.p2_discord || '' },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    canEdit: r.status !== 'approved' && regOpen(),
  };
}

async function statusRoute(request, env, url, d, ctx) {
  const token = url.searchParams.get('t') || '';
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return json({ error: 'not_found' }, 404);
  const row = await d.prepare('SELECT * FROM vibesmas_duos WHERE token_hash = ?').bind(await sha256Hex(token)).first();
  if (!row) return json({ error: 'not_found' }, 404);

  if (request.method === 'GET') return json({ duo: ownView(row) });

  if (request.method === 'PUT') {
    if (row.status === 'approved') return json({ error: 'locked' }, 409);
    if (!regOpen()) return json({ error: 'registration_closed' }, 409);
    const v = validateDuo(await readJson(request));
    if (v.error) return json(v, 400);
    const conflict = await checkConflicts(d, v.duo, row.id);
    if (conflict) return json(conflict, 409);
    const tw = await checkTwitch(env, v.duo);
    if (tw) return json(tw, 400);
    const x = v.duo;
    await d
      .prepare(`UPDATE vibesmas_duos SET name = ?, status = 'pending', streams = ?, p1_epic = ?, p1_twitch = ?, p1_discord = ?,
        p2_epic = ?, p2_twitch = ?, p2_discord = ?, updated_at = ? WHERE id = ?`)
      .bind(x.name, x.streams, x.p1_epic, x.p1_twitch, x.p1_discord, x.p2_epic, x.p2_twitch, x.p2_discord, nowIso(), row.id)
      .run();
    await log(d, 'sign-up', `${x.name} edited their sign-up`);
    notify(env, ctx, url.origin, row.status === 'declined' ? 'Vibesmas sign-up sent again' : 'Vibesmas sign-up edited', x);
    const updated = await d.prepare('SELECT * FROM vibesmas_duos WHERE id = ?').bind(row.id).first();
    return json({ duo: ownView(updated) });
  }

  if (request.method === 'DELETE') {
    if (Date.now() >= Date.parse(TOURNAMENT.start)) return json({ error: 'locked' }, 409);
    await d.batch([
      d.prepare('DELETE FROM vibesmas_scores WHERE duo_id = ?').bind(row.id),
      d.prepare('DELETE FROM vibesmas_duos WHERE id = ?').bind(row.id),
    ]);
    await log(d, 'sign-up', `${row.name} withdrew`);
    if (row.status === 'approved') await purgePublic();
    return json({ ok: true });
  }

  return json({ error: 'not_found' }, 404);
}

// ---------- admin ----------

function adminDuo(r) {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    note: r.note || '',
    streams: r.streams,
    p1: { epic: r.p1_epic, twitch: r.p1_twitch || '', discord: r.p1_discord || '' },
    p2: { epic: r.p2_epic, twitch: r.p2_twitch || '', discord: r.p2_discord || '' },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function adminRoute(request, env, url, d, admin) {
  const sub = url.pathname.slice('/api/vibesmas/admin/'.length);
  const actor = admin.email === 'local-dev' ? 'local test' : admin.email.split('@')[0];

  if (sub === 'state' && request.method === 'GET') {
    const [{ results: duos }, { results: scores }, { results: games }, { results: logRows }, settings] = await Promise.all([
      d.prepare('SELECT * FROM vibesmas_duos ORDER BY created_at').all(),
      d.prepare('SELECT * FROM vibesmas_scores').all(),
      d.prepare('SELECT * FROM vibesmas_games ORDER BY game').all(),
      d.prepare('SELECT * FROM vibesmas_log ORDER BY id DESC LIMIT 40').all(),
      readSettings(d),
    ]);
    return json({
      ...TOURNAMENT,
      ...settings,
      regOpen: regOpen(),
      signedIn: admin.email,
      duos: (duos || []).map(adminDuo),
      scores: scores || [],
      gameCount: TOURNAMENT.games,
      games: games || [],
      log: logRows || [],
    });
  }

  if (sub === 'duo' && request.method === 'POST') {
    const b = (await readJson(request)) || {};
    const id = Number(b.id);
    const row = await d.prepare('SELECT * FROM vibesmas_duos WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'not_found' }, 404);
    const note = clean(b.note, 300) || null;
    const action = b.action;
    if (action === 'approve') {
      if (row.status !== 'approved' && (await approvedCount(d)) >= TOURNAMENT.maxDuos) return json({ error: 'full' }, 409);
      await d.prepare("UPDATE vibesmas_duos SET status = 'approved', note = ?, updated_at = ? WHERE id = ?").bind(note, nowIso(), id).run();
      await log(d, actor, `approved ${row.name}`);
    } else if (action === 'decline') {
      await d.prepare("UPDATE vibesmas_duos SET status = 'declined', note = ?, updated_at = ? WHERE id = ?").bind(note, nowIso(), id).run();
      await log(d, actor, `declined ${row.name}`);
    } else if (action === 'pending') {
      await d.prepare("UPDATE vibesmas_duos SET status = 'pending', updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
      await log(d, actor, `moved ${row.name} back to waiting`);
    } else if (action === 'delete') {
      await d.batch([
        d.prepare('DELETE FROM vibesmas_scores WHERE duo_id = ?').bind(id),
        d.prepare('DELETE FROM vibesmas_duos WHERE id = ?').bind(id),
      ]);
      await log(d, actor, `deleted ${row.name}`);
    } else {
      return json({ error: 'bad_request' }, 400);
    }
    await purgePublic();
    return json({ ok: true });
  }

  if (sub === 'scores' && request.method === 'POST') {
    const b = (await readJson(request)) || {};
    const game = Number(b.game);
    if (!Number.isInteger(game) || game < 1 || game > TOURNAMENT.games) return json({ error: 'bad_game' }, 400);
    const rows = Array.isArray(b.rows) ? b.rows : [];
    const { results: approved } = await d.prepare("SELECT id FROM vibesmas_duos WHERE status = 'approved'").all();
    const ids = new Set((approved || []).map((r) => r.id));
    const seen = new Set();
    const clean_ = [];
    for (const r of rows) {
      const id = Number(r.id);
      if (!ids.has(id)) continue;
      if (r.placement === '' || r.placement === null || r.placement === undefined) continue;
      const placement = Number(r.placement);
      const kills = Number(r.kills || 0);
      if (!Number.isInteger(placement) || placement < 1 || placement > 100) return json({ error: 'bad_placement', id }, 400);
      if (!Number.isInteger(kills) || kills < 0 || kills > 99) return json({ error: 'bad_kills', id }, 400);
      if (seen.has(placement)) return json({ error: 'duplicate_placement', placement }, 400);
      seen.add(placement);
      clean_.push({ id, placement, kills });
    }
    const t = nowIso();
    const stmts = [d.prepare('DELETE FROM vibesmas_scores WHERE game = ?').bind(game)];
    for (const r of clean_) {
      stmts.push(d.prepare('INSERT INTO vibesmas_scores (game, duo_id, placement, kills) VALUES (?, ?, ?, ?)').bind(game, r.id, r.placement, r.kills));
    }
    const publish = b.publish === true ? 1 : b.publish === false ? 0 : null;
    if (publish === null) {
      stmts.push(d.prepare('INSERT INTO vibesmas_games (game, published, updated_at) VALUES (?, 0, ?) ON CONFLICT(game) DO UPDATE SET updated_at = excluded.updated_at').bind(game, t));
    } else {
      stmts.push(d.prepare('INSERT INTO vibesmas_games (game, published, updated_at) VALUES (?, ?, ?) ON CONFLICT(game) DO UPDATE SET published = excluded.published, updated_at = excluded.updated_at').bind(game, publish, t));
    }
    await d.batch(stmts);
    await log(d, actor, publish === 1 ? `published game ${game}` : publish === 0 ? `unpublished game ${game}` : `saved a draft of game ${game}`);
    await purgePublic();
    return json({ ok: true });
  }

  if (sub === 'settings' && request.method === 'POST') {
    const b = (await readJson(request)) || {};
    const changes = [];
    if (b.phase !== undefined) {
      if (!PHASES.includes(b.phase)) return json({ error: 'bad_request' }, 400);
      await setSetting(d, 'vibesmas_phase', b.phase);
      if (b.phase === 'review') {
        await setSetting(d, 'vibesmas_review_until', new Date(Date.now() + 86400000).toISOString());
      } else if (b.phase !== 'final') {
        await setSetting(d, 'vibesmas_review_until', null);
      }
      changes.push(`set the tournament to "${b.phase}"`);
    }
    if (b.currentGame !== undefined) {
      const g = b.currentGame === null ? null : Number(b.currentGame);
      if (g !== null && (!Number.isInteger(g) || g < 1 || g > TOURNAMENT.games)) return json({ error: 'bad_game' }, 400);
      await setSetting(d, 'vibesmas_current_game', g);
      changes.push(g ? `marked game ${g} as in progress` : 'cleared the game in progress');
    }
    if (b.outfitWinner !== undefined) {
      const w = clean(b.outfitWinner, 40) || null;
      await setSetting(d, 'vibesmas_outfit', w);
      changes.push(w ? `set the outfit winner to ${w}` : 'cleared the outfit winner');
    }
    for (const c of changes) await log(d, actor, c);
    await purgePublic();
    return json({ ok: true });
  }

  return json({ error: 'not_found' }, 404);
}
