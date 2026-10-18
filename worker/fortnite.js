// VibesByVince — Fortnite Hub API routes (/api/fortnite/*).
//
// All data comes from fortnite-api.com (an unofficial, community-run API;
// Epic has no public one). Everything is fetched here on the server and
// cached, so visitors' browsers only ever talk to vibesbyvince.com:
//
//   /api/fortnite/shop      today's Item Shop, trimmed to what the page shows
//   /api/fortnite/map       current map locations for the drop randomizer
//   /api/fortnite/stats     player stats (needs the FORTNITE_API_KEY secret)
//   /api/fortnite/img?u=…   image pass-through, fortnite-api.com images only
//
// FORTNITE_API_KEY is a Cloudflare secret (Worker → Settings → Variables and
// Secrets), like CALENDAR_ICS_URL. The shop and map work without it.

const API = 'https://fortnite-api.com';
const CACHE_VERSION = 2;

export async function handleFortnite(request, env, url) {
  const route = url.pathname.slice('/api/fortnite/'.length);
  try {
    // shop + map: serve the already-trimmed result from Cloudflare's edge
    // cache, so the big upstream JSON is only processed once per cache period
    if (route === 'shop') return await edgeCached(request, shop);
    if (route === 'map') return await edgeCached(request, map);
    if (route === 'stats') return await stats(env, url);
    if (route === 'img') return await image(url);
    return reply({ error: 'not_found' }, 404, 'no-store');
  } catch (err) {
    return reply({ error: 'unavailable', message: String(err) }, 200, 'public, max-age=60');
  }
}

// ---------- shop ----------
// The shop resets every day at 00:00 UTC (5:00 PM Arizona time). The trimmed
// result is cached until a couple of minutes after the next reset.

async function shop() {
  const res = await fetch(`${API}/v2/shop?language=en`, {
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`shop: ${res.status}`);
  const { data } = await res.json();
  const shopDate = (data.date || '').slice(0, 10);

  const now = new Date();
  const nextResetMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);

  const items = [];
  for (const entry of data.entries || []) {
    const br = entry.brItems || [];
    if (!br.length) continue; // skip Jam Tracks, cars, LEGO kits etc.
    const first = br[0];
    const isBundle = !!entry.bundle;
    const rawImage =
      (isBundle && entry.bundle.image) ||
      (entry.newDisplayAsset && entry.newDisplayAsset.renderImages && entry.newDisplayAsset.renderImages[0] && entry.newDisplayAsset.renderImages[0].image) ||
      (first.images && (first.images.featured || first.images.icon || first.images.smallIcon)) ||
      null;
    const outDate = entry.outDate ? Date.parse(entry.outDate) : null;

    items.push({
      id: entry.offerId,
      name: cleanText(isBundle ? entry.bundle.name : first.name),
      type: isBundle ? 'Bundle' : (first.type && first.type.displayValue) || 'Item',
      typeKey: isBundle ? 'bundle' : (first.type && first.type.value) || 'other',
      rarity: (first.rarity && first.rarity.value) || 'common',
      rarityName: (first.rarity && first.rarity.displayValue) || '',
      series: (first.series && first.series.value) || null,
      price: entry.finalPrice,
      regularPrice: entry.regularPrice,
      // some section names arrive with a broken ® character; drop it
      section: cleanText(entry.layout && entry.layout.name) || 'More in the shop',
      sectionIndex: entry.layout && typeof entry.layout.index === 'number' ? entry.layout.index : 9999,
      sort: entry.sortPriority || 0,
      isNew: !!entry.inDate && entry.inDate.slice(0, 10) === shopDate,
      leavingTonight: !!outDate && outDate <= nextResetMs + 3600 * 1000,
      image: rawImage ? proxied(rawImage) : null,
    });
  }

  // same section order as the in-game shop
  items.sort((a, b) => a.sectionIndex - b.sectionIndex || b.sort - a.sort);

  // Right after the reset the API can still return yesterday's shop for a
  // few minutes; in that case only cache for a minute so today's shows up.
  const isToday = shopDate === now.toISOString().slice(0, 10);
  const secondsLeft = isToday ? Math.max(60, Math.floor((nextResetMs - now.getTime()) / 1000) + 120) : 60;

  return reply(
    {
      date: data.date,
      nextReset: new Date(nextResetMs).toISOString(),
      vbuckIcon: data.vbuckIcon ? proxied(data.vbuckIcon) : null,
      items,
    },
    200,
    `public, max-age=${Math.min(secondsLeft, 900)}, s-maxage=${secondsLeft}`
  );
}

// ---------- map ----------
// Locations come with world coordinates. They're converted to 0–1 positions
// on the map image so the page can place a marker. The numbers below were
// fitted against the labelled map (world x → across, world y → down; every
// named location lands within ~1px of its label). If markers drift after a
// big map change, re-fit them. Duplicate names (e.g. several
// "Override Console"s) are dropped.

const MAP_FIT = { ax: 3.22439e-6, bx: 0.477298, ay: 3.22996e-6, by: 0.495916 };

async function map() {
  const res = await fetch(`${API}/v1/map?language=en`, {
    cf: { cacheTtl: 6 * 3600, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`map: ${res.status}`);
  const { data } = await res.json();

  const seen = new Set();
  const spots = [];
  for (const p of data.pois || []) {
    const name = (p.name || '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const { x, y } = p.location || {};
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    spots.push({
      name,
      major: (p.id || '').includes('.POI.'),
      left: clamp01(x * MAP_FIT.ax + MAP_FIT.bx),
      top: clamp01(y * MAP_FIT.ay + MAP_FIT.by),
    });
  }

  return reply(
    {
      image: data.images && data.images.pois ? proxied(data.images.pois) : null,
      spots,
    },
    200,
    'public, max-age=3600, s-maxage=21600'
  );
}

// ---------- stats ----------

const ACCOUNT_TYPES = ['epic', 'psn', 'xbl'];
const TIME_WINDOWS = ['lifetime', 'season'];

async function stats(env, url) {
  const name = (url.searchParams.get('name') || '').trim();
  const accountType = ACCOUNT_TYPES.includes(url.searchParams.get('platform')) ? url.searchParams.get('platform') : 'epic';
  const timeWindow = TIME_WINDOWS.includes(url.searchParams.get('window')) ? url.searchParams.get('window') : 'lifetime';

  if (name.length < 3 || name.length > 32) {
    return reply({ error: 'bad_name' }, 200, 'no-store');
  }
  if (!env.FORTNITE_API_KEY) {
    return reply({ error: 'not_configured' }, 200, 'public, max-age=60');
  }

  const q = new URLSearchParams({ name, accountType, timeWindow, image: 'none' });
  const res = await fetch(`${API}/v2/stats/br/v2?${q}`, {
    headers: { Authorization: env.FORTNITE_API_KEY },
    cf: { cacheTtl: 600, cacheEverything: true },
  });

  // fortnite-api.com: 403 = stats are private, 404 = no such account
  if (res.status === 403) return reply({ error: 'private' }, 200, 'public, max-age=120');
  if (res.status === 404) return reply({ error: 'not_found' }, 200, 'public, max-age=120');
  if (res.status === 401) return reply({ error: 'not_configured' }, 200, 'public, max-age=60');
  if (!res.ok) throw new Error(`stats: ${res.status}`);

  const { data } = await res.json();
  const all = (data.stats && data.stats.all) || {};
  const pick = (m) =>
    m
      ? {
          wins: m.wins || 0,
          matches: m.matches || 0,
          winRate: m.winRate || 0,
          kd: m.kd || 0,
          kills: m.kills || 0,
          killsPerMatch: m.killsPerMatch || 0,
          playersOutlived: m.playersOutlived || 0,
          minutesPlayed: m.minutesPlayed || 0,
        }
      : null;

  return reply(
    {
      name: data.account && data.account.name,
      battlePassLevel: data.battlePass ? data.battlePass.level : null,
      platform: accountType,
      window: timeWindow,
      modes: {
        overall: pick(all.overall),
        solo: pick(all.solo),
        duos: pick(all.duo),
        squads: pick(all.squad),
      },
    },
    200,
    'public, max-age=300, s-maxage=600'
  );
}

// ---------- image pass-through ----------
// Only images hosted on fortnite-api.com/images/ can be fetched, so this
// can't be used to load anything else through the site.

function proxied(src) {
  return `/api/fortnite/img?u=${encodeURIComponent(src)}`;
}

async function image(url) {
  let src;
  try {
    src = new URL(url.searchParams.get('u') || '');
  } catch {
    return new Response('not found', { status: 404 });
  }
  if (src.protocol !== 'https:' || src.hostname !== 'fortnite-api.com' || !src.pathname.startsWith('/images/')) {
    return new Response('not found', { status: 404 });
  }
  const res = await fetch(src.toString(), { cf: { cacheTtl: 7 * 86400, cacheEverything: true } });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) {
    return new Response('not found', { status: 404, headers: { 'cache-control': 'public, max-age=300' } });
  }
  return new Response(res.body, {
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=86400, s-maxage=604800',
      'x-content-type-options': 'nosniff',
    },
  });
}

// ---------- helpers ----------

// Uses the response's own s-maxage as the edge cache time. (The Cache API
// works on the vibesbyvince.com domain; under `wrangler dev` it's a no-op.)
async function edgeCached(request, build) {
  const cache = caches.default;
  // bump CACHE_VERSION when the shape of these responses changes, so stale
  // cached copies are skipped right away after a deploy
  const key = new Request(`${new URL(request.url).origin}${new URL(request.url).pathname}?v=${CACHE_VERSION}`, { method: 'GET' });
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

function cleanText(s) {
  return typeof s === 'string' ? s.replace(/�/g, '').replace(/\s+/g, ' ').trim() : '';
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function reply(data, status, cacheControl) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': cacheControl },
  });
}
