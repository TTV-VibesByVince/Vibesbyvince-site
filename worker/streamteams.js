// VibesByVince — stream teams raid finder (/streamteams).
//
//   GET /api/streamteams              who's live across the teams below
//   GET /api/streamteams/img?u=…      Twitch image pass-through (avatars,
//                                     live previews) so visitors' browsers
//                                     only ever talk to vibesbyvince.com
//
// Uses an *app* access token (client credentials) from the same Twitch
// app as the calendar (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET). That only
// reads public information and never touches Vince's own Twitch login.
//
// To add or remove a team: edit TEAMS (the part after twitch.tv/team/).

import { appHelix as helix } from './twitch-app.js';

const TEAMS = ['lllicit', 'sokasquad', 'finestfam', 'nasu', 'capycafe', 'tizzytavern', 'pizzapartytv'];
const SELF_LOGIN = 'vibesbyvince'; // don't suggest raiding yourself

const LIVE_CACHE_SECONDS = 60; // live list refresh
const ROSTER_CACHE_SECONDS = 6 * 3600; // team member lists change rarely
const CACHE_VERSION = 1;
// Twitch image hosts (avatars, live previews, clip thumbnails)
const IMAGE_HOSTS = ['static-cdn.jtvnw.net', 'clips-media-assets2.twitch.tv'];

export async function handleStreamTeams(request, env, url) {
  try {
    if (url.pathname === '/api/streamteams') return await edgeCached(request, 'live', LIVE_CACHE_SECONDS, () => live(env, request));
    if (url.pathname === '/api/streamteams/img') return await image(url);
    return reply({ error: 'not_found' }, 404, 'no-store');
  } catch (err) {
    return reply({ error: 'unavailable', message: String(err && err.message ? err.message : err) }, 200, 'public, max-age=30');
  }
}

// ---------- live list ----------

async function live(env, request) {
  // Local testing without Twitch keys: STREAMTEAMS_SAMPLE=true in .dev.vars
  const local = ['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname);
  if (local && env.STREAMTEAMS_SAMPLE === 'true') return sample();

  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    return reply({ error: 'not_configured' }, 200, 'public, max-age=60');
  }

  const rosters = await getRosters(env, request);

  // one entry per streamer, listing every team they're on
  const members = new Map();
  for (const team of rosters) {
    for (const u of team.users) {
      if (u.login === SELF_LOGIN) continue;
      if (!members.has(u.id)) members.set(u.id, { id: u.id, login: u.login, name: u.name, teams: [] });
      members.get(u.id).teams.push(team.slug);
    }
  }

  // who's live (100 ids per request)
  const ids = [...members.keys()];
  const streams = [];
  for (let i = 0; i < ids.length; i += 100) {
    const q = ids.slice(i, i + 100).map((id) => `user_id=${id}`).join('&');
    const res = await helix(env, `/streams?first=100&type=live&${q}`);
    streams.push(...(res.data || []));
  }

  // profile pictures for the live ones
  const avatars = new Map();
  const liveIds = streams.map((s) => s.user_id);
  for (let i = 0; i < liveIds.length; i += 100) {
    const q = liveIds.slice(i, i + 100).map((id) => `id=${id}`).join('&');
    const res = await helix(env, `/users?${q}`);
    for (const u of res.data || []) avatars.set(u.id, u.profile_image_url);
  }

  const minute = Math.floor(Date.now() / 60000); // new preview image each minute
  const liveList = streams.map((s) => {
    const m = members.get(s.user_id) || { teams: [] };
    return {
      login: s.user_login,
      name: s.user_name,
      game: s.game_name || 'No category',
      title: s.title || '',
      viewers: s.viewer_count || 0,
      startedAt: s.started_at,
      language: s.language,
      teams: m.teams,
      avatar: avatars.has(s.user_id) ? proxied(avatars.get(s.user_id).replace(/-\d+x\d+\./, '-70x70.')) : null,
      preview: s.thumbnail_url ? proxied(`${s.thumbnail_url.replace('{width}', '440').replace('{height}', '248')}?m=${minute}`) : null,
    };
  });
  liveList.sort((a, b) => b.viewers - a.viewers);

  const liveLogins = new Set(liveList.map((s) => s.login));
  const offline = [...members.values()]
    .filter((m) => !liveLogins.has(m.login))
    .map((m) => ({ login: m.login, name: m.name, teams: m.teams }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return reply(
    {
      updatedAt: new Date().toISOString(),
      teams: rosters.map((t) => ({ slug: t.slug, name: t.name, members: t.users.length, ok: t.ok })),
      live: liveList,
      offline,
    },
    200,
    `public, max-age=${LIVE_CACHE_SECONDS}, s-maxage=${LIVE_CACHE_SECONDS}`
  );
}

// Team member lists, cached for hours (a team that fails to load is kept
// out of the cache so it's retried next time).
async function getRosters(env, request) {
  const res = await edgeCached(request, 'rosters', ROSTER_CACHE_SECONDS, async () => {
    const teams = await Promise.all(
      TEAMS.map(async (slug) => {
        try {
          const j = await helix(env, `/teams?name=${encodeURIComponent(slug)}`);
          const t = (j.data || [])[0];
          if (!t) return { slug, name: slug, users: [], ok: false };
          return {
            slug,
            name: t.team_display_name || t.team_name || slug,
            ok: true,
            users: (t.users || []).map((u) => ({ id: u.user_id, login: u.user_login, name: u.user_name })),
          };
        } catch {
          return { slug, name: slug, users: [], ok: false };
        }
      })
    );
    const allOk = teams.every((t) => t.ok);
    return reply({ teams }, 200, `public, max-age=${allOk ? ROSTER_CACHE_SECONDS : 60}, s-maxage=${allOk ? ROSTER_CACHE_SECONDS : 60}`);
  });
  return (await res.json()).teams;
}

// ---------- image pass-through ----------

export function proxied(src) {
  return `/api/streamteams/img?u=${encodeURIComponent(src)}`;
}

async function image(url) {
  let src;
  try {
    src = new URL(url.searchParams.get('u') || '');
  } catch {
    return new Response('not found', { status: 404 });
  }
  if (src.protocol !== 'https:' || !IMAGE_HOSTS.includes(src.hostname)) return new Response('not found', { status: 404 });
  const isPreview = src.pathname.includes('/previews-ttv/');
  const ttl = isPreview ? 60 : 86400;
  const res = await fetch(src.toString(), { cf: { cacheTtl: ttl, cacheEverything: true } });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) return new Response('not found', { status: 404, headers: { 'cache-control': 'public, max-age=60' } });
  return new Response(res.body, {
    headers: { 'content-type': type, 'cache-control': `public, max-age=${ttl}`, 'x-content-type-options': 'nosniff' },
  });
}

// ---------- helpers ----------

async function edgeCached(request, name, seconds, build) {
  const cache = caches.default;
  const key = new Request(`${new URL(request.url).origin}/api/streamteams/__cache/${name}?v=${CACHE_VERSION}`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await build();
  if (res.status === 200) {
    const sMax = /s-maxage=(\d+)/.exec(res.headers.get('cache-control') || '');
    if (sMax) {
      const copy = new Response(res.clone().body, res);
      copy.headers.set('cache-control', `public, max-age=${sMax[1]}`);
      await cache.put(key, copy);
    }
  }
  return res;
}

function reply(data, status, cacheControl) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': cacheControl },
  });
}

// Fake data for local design testing only (never used on the real site).
function sample() {
  const now = Date.now();
  const games = ['Fortnite', 'Fortnite', 'Fortnite', 'Just Chatting', 'Phasmophobia', 'Minecraft', 'Magic: The Gathering', 'Dead by Daylight', 'Fortnite', 'Lethal Company'];
  const live = games.map((game, i) => ({
    login: `samplestreamer${i + 1}`,
    name: `SampleStreamer${i + 1}`,
    game,
    title: `Sample stream title number ${i + 1} | !socials`,
    viewers: [69, 51, 48, 41, 34, 14, 14, 7, 4, 2][i],
    startedAt: new Date(now - [185, 95, 40, 220, 12, 70, 8, 130, 300, 3][i] * 60000).toISOString(),
    language: 'en',
    teams: [TEAMS[i % TEAMS.length], ...(i % 3 === 0 ? [TEAMS[(i + 3) % TEAMS.length]] : [])],
    avatar: null,
    preview: null,
  }));
  return reply(
    {
      updatedAt: new Date().toISOString(),
      teams: TEAMS.map((slug) => ({ slug, name: slug, members: 20, ok: true })),
      live,
      offline: [{ login: 'sampleoffline', name: 'SampleOffline', teams: [TEAMS[0]] }],
      sample: true,
    },
    200,
    'no-store'
  );
}
