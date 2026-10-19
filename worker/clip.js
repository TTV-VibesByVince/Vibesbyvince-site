// VibesByVince — newest Twitch clip for the homepage "Latest Content" card.
//
//   GET /api/clip  →  { url, title, thumbnail, createdAt, views }
//
// Twitch's clips API sorts by most viewed, not newest, so we ask for the
// clips made in a time window and pick the newest one ourselves: last 7
// days first, then 30 days, then a year. If there are none, the card keeps
// linking to the clips page.

import { appConfigured, appHelix } from './twitch-app.js';
import { proxied } from './streamteams.js';

const CHANNEL_LOGIN = 'vibesbyvince';
const WINDOWS_DAYS = [7, 30, 365];
const CACHE_SECONDS = 600; // a new clip shows up within ~10 minutes
const CACHE_VERSION = 1;

let broadcasterId = null;

export async function handleClip(request, env) {
  const cache = caches.default;
  const key = new Request(`${new URL(request.url).origin}/api/clip/__cache?v=${CACHE_VERSION}`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  let res;
  try {
    res = await latestClip(env);
  } catch (err) {
    return reply({ error: 'unavailable', message: String(err && err.message ? err.message : err) }, 'public, max-age=60');
  }
  if (res.status === 200 && !res.headers.get('x-no-cache')) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set('cache-control', `public, max-age=${CACHE_SECONDS}`);
    await cache.put(key, copy);
  }
  return res;
}

async function latestClip(env) {
  if (!appConfigured(env)) return reply({ error: 'not_configured' }, 'public, max-age=60', true);

  if (!broadcasterId) {
    const u = await appHelix(env, `/users?login=${CHANNEL_LOGIN}`);
    broadcasterId = u.data && u.data[0] && u.data[0].id;
    if (!broadcasterId) throw new Error('channel not found');
  }

  const now = Date.now();
  for (const days of WINDOWS_DAYS) {
    const started = new Date(now - days * 86400000).toISOString();
    const j = await appHelix(env, `/clips?broadcaster_id=${broadcasterId}&first=100&started_at=${encodeURIComponent(started)}&ended_at=${encodeURIComponent(new Date(now).toISOString())}`);
    const clips = (j.data || []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
    const c = clips[0];
    if (c) {
      return reply(
        {
          url: c.url,
          title: c.title,
          thumbnail: c.thumbnail_url ? proxied(c.thumbnail_url) : null,
          createdAt: c.created_at,
          views: c.view_count,
        },
        `public, max-age=${CACHE_SECONDS}`
      );
    }
  }
  return reply({ error: 'no_clips' }, `public, max-age=${CACHE_SECONDS}`);
}

function reply(data, cacheControl, noCache = false) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': cacheControl,
      ...(noCache ? { 'x-no-cache': '1' } : {}),
    },
  });
}
