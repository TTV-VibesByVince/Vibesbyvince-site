// VibesByVince — Twitch schedule sync for the stream calendar.
//
// One-way: the site's calendar is the source of truth and every change is
// copied to the Twitch schedule. Uses Vince's own Twitch login with ONLY
// the `channel:manage:schedule` permission.
//
// Secrets (Cloudflare → Worker → Settings → Variables and Secrets):
//   TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET  — from dev.twitch.tv/console
//
// The Twitch login tokens are stored in the D1 `settings` table, encrypted
// (AES-GCM) with a key derived from TWITCH_CLIENT_SECRET, so a copy of the
// database alone can't be used to act on the channel.
//
// Twitch rules worth knowing (from the Helix API reference):
//   - only Affiliates/Partners may add one-off (non-recurring) segments or
//     move a segment's start time — the admin page shows the error if so
//   - titles max 140 characters, length 30–1380 minutes

import { getSetting, setSetting, guessTag } from './calendar.js';

const HELIX = 'https://api.twitch.tv/helix';
const TIMEZONE = 'America/Phoenix';
const SCOPE = 'channel:manage:schedule';

function configured(env) {
  return !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
}

function redirectUri(requestUrl) {
  return `${new URL(requestUrl).origin}/api/calendar/admin/twitch/callback`;
}

// ---------- token storage (encrypted) ----------

async function aesKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vbv-twitch-tokens:${env.TWITCH_CLIENT_SECRET}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), data));
  return `${b64(iv)}.${b64(ct)}`;
}

async function unseal(env, s) {
  const [iv, ct] = String(s).split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

async function loadTokens(env, d) {
  const sealed = await getSetting(d, 'twitch_tokens');
  if (!sealed) return null;
  try {
    return await unseal(env, sealed);
  } catch {
    return null; // secret changed: treat as disconnected
  }
}

async function saveTokens(env, d, t) {
  await setSetting(d, 'twitch_tokens', t ? await seal(env, t) : null);
}

async function refresh(env, d, t) {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refresh,
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    // refresh token revoked (password change, access removed in Twitch settings…)
    if (res.status === 400 || res.status === 401) await saveTokens(env, d, null);
    throw new Error('Twitch login expired, please reconnect Twitch');
  }
  const j = await res.json();
  const next = { ...t, access: j.access_token, refresh: j.refresh_token || t.refresh, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  await saveTokens(env, d, next);
  return next;
}

async function session(env, d) {
  if (!configured(env)) return null;
  let t = await loadTokens(env, d);
  if (!t) return null;
  if (!t.exp || t.exp - Date.now() < 120000) t = await refresh(env, d, t);
  return t;
}

// Calls Helix as Vince; refreshes once on a 401.
async function helix(env, d, method, path, body) {
  let t = await session(env, d);
  if (!t) throw new Error('Twitch is not connected');
  const go = (tok) =>
    fetch(`${HELIX}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tok.access}`,
        'client-id': env.TWITCH_CLIENT_ID,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  let res = await go(t);
  if (res.status === 401) {
    t = await refresh(env, d, t);
    res = await go(t);
  }
  return { res, tokens: t };
}

async function helixError(res) {
  let msg = `Twitch error ${res.status}`;
  try {
    const j = await res.json();
    if (j && j.message) msg = j.message;
  } catch {}
  if (res.status === 403 && /partner|affiliate/i.test(msg)) msg = 'Twitch only lets Affiliates and Partners add one-off schedule entries';
  if (res.status === 429) msg = 'Twitch is busy, try again in a minute';
  return msg;
}

// ---------- public API used by calendar.js ----------

export const twitch = {
  async status(env, d) {
    if (!configured(env)) return { configured: false, connected: false };
    const t = await loadTokens(env, d);
    if (!t) return { configured: true, connected: false };
    return { configured: true, connected: true, login: t.login, displayName: t.displayName, broadcasterType: t.broadcasterType || '' };
  },

  async connect(request, env, d) {
    if (!configured(env)) return new Response('Twitch app keys are not set up yet.', { status: 503 });
    const state = b64(crypto.getRandomValues(new Uint8Array(24)));
    await setSetting(d, 'twitch_oauth_state', JSON.stringify({ state, at: Date.now() }));
    const q = new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      redirect_uri: redirectUri(request.url),
      response_type: 'code',
      scope: SCOPE,
      state,
      force_verify: 'true',
    });
    return Response.redirect(`https://id.twitch.tv/oauth2/authorize?${q}`, 302);
  },

  async callback(request, env, d, url) {
    const back = (msg) => Response.redirect(`${url.origin}/calendar/admin?twitch=${encodeURIComponent(msg)}`, 302);
    const saved = JSON.parse((await getSetting(d, 'twitch_oauth_state')) || 'null');
    await setSetting(d, 'twitch_oauth_state', null);
    if (url.searchParams.get('error')) return back('cancelled');
    if (!saved || saved.state !== url.searchParams.get('state') || Date.now() - saved.at > 10 * 60000) return back('expired');

    const tokRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID,
        client_secret: env.TWITCH_CLIENT_SECRET,
        code: url.searchParams.get('code') || '',
        grant_type: 'authorization_code',
        redirect_uri: redirectUri(request.url),
      }),
    });
    if (!tokRes.ok) return back('failed');
    const tok = await tokRes.json();
    if (!String(tok.scope || '').includes(SCOPE) && !(Array.isArray(tok.scope) && tok.scope.includes(SCOPE))) return back('failed');

    const userRes = await fetch(`${HELIX}/users`, {
      headers: { authorization: `Bearer ${tok.access_token}`, 'client-id': env.TWITCH_CLIENT_ID },
    });
    if (!userRes.ok) return back('failed');
    const user = ((await userRes.json()).data || [])[0];
    if (!user) return back('failed');

    await saveTokens(env, d, {
      access: tok.access_token,
      refresh: tok.refresh_token,
      exp: Date.now() + (tok.expires_in || 3600) * 1000,
      userId: user.id,
      login: user.login,
      displayName: user.display_name,
      broadcasterType: user.broadcaster_type || '',
    });
    return back('connected');
  },

  async disconnect(env, d) {
    const t = await loadTokens(env, d);
    if (t && t.access && env.TWITCH_CLIENT_ID) {
      try {
        await fetch('https://id.twitch.tv/oauth2/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, token: t.access }),
        });
      } catch {}
    }
    await saveTokens(env, d, null);
  },

  async searchCategories(env, d, q) {
    try {
      const { res } = await helix(env, d, 'GET', `/search/categories?first=8&query=${encodeURIComponent(q)}`);
      if (!res.ok) return [];
      const j = await res.json();
      return (j.data || []).map((c) => ({ id: c.id, name: c.name, art: (c.box_art_url || '').replace('{width}x{height}', '52x72') }));
    } catch {
      return [];
    }
  },

  // Create or update the matching Twitch segment, and record the result on
  // the event row. Past streams aren't sent (Twitch schedules are future-only).
  async syncEvent(env, d, row) {
    const set = (status, error, segId) =>
      d
        .prepare('UPDATE events SET twitch_status = ?, twitch_error = ?, twitch_segment_id = COALESCE(?, twitch_segment_id) WHERE id = ?')
        .bind(status, error || null, segId || null, row.id)
        .run();

    if (Date.parse(row.start_utc) <= Date.now()) return set('past', null, null);
    if (!configured(env) || !(await loadTokens(env, d))) return set('off', null, null);

    try {
      const t = await session(env, d);
      const body = {
        start_time: row.start_utc.replace(/\.\d{3}Z$/, 'Z'),
        timezone: TIMEZONE,
        duration: String(row.duration_min),
        title: row.title.slice(0, 140),
        ...(row.category_id ? { category_id: row.category_id } : {}),
      };

      let res;
      if (row.twitch_segment_id) {
        ({ res } = await helix(env, d, 'PATCH', `/schedule/segment?broadcaster_id=${t.userId}&id=${encodeURIComponent(row.twitch_segment_id)}`, body));
        if (res.status === 404) {
          // removed on Twitch's side: create it again
          ({ res } = await helix(env, d, 'POST', `/schedule/segment?broadcaster_id=${t.userId}`, { ...body, is_recurring: false }));
        }
      } else {
        ({ res } = await helix(env, d, 'POST', `/schedule/segment?broadcaster_id=${t.userId}`, { ...body, is_recurring: false }));
      }

      if (!res.ok) return set('error', await helixError(res), null);
      const j = await res.json();
      const seg = j.data && j.data.segments && j.data.segments[0];
      return set('ok', null, seg ? seg.id : null);
    } catch (err) {
      return set('error', String(err.message || err), null);
    }
  },

  // Remove the matching Twitch segment before an event is deleted.
  async removeEvent(env, d, row) {
    if (!row.twitch_segment_id || Date.parse(row.start_utc) <= Date.now()) return { ok: true };
    if (!configured(env) || !(await loadTokens(env, d))) return { ok: true };
    try {
      const t = await session(env, d);
      const { res } = await helix(env, d, 'DELETE', `/schedule/segment?broadcaster_id=${t.userId}&id=${encodeURIComponent(row.twitch_segment_id)}`);
      if (res.ok || res.status === 404) return { ok: true };
      return { ok: false, error: await helixError(res) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  },

  // Reads the current Twitch schedule for the import. One-off segments are
  // kept as they are (linked by id). Repeating series are expanded into one
  // entry per week and the series is deleted on Twitch; the new one-off
  // entries are then created by syncEvent.
  async importSchedule(env, d, { weeks = 8 } = {}) {
    if (!configured(env)) return { segments: [], error: 'Twitch app keys not set up' };
    let t;
    try {
      t = await session(env, d);
    } catch (err) {
      return { segments: [], error: String(err.message || err) };
    }
    if (!t) return { segments: [], error: 'Twitch not connected yet (connect it, then import again)' };

    const until = Date.now() + weeks * 7 * 86400000;
    const segments = [];
    const recurringIds = new Map(); // one id per series is enough to delete it
    let after = '';
    for (let page = 0; page < 10; page++) {
      const { res } = await helix(env, d, 'GET', `/schedule?broadcaster_id=${t.userId}&first=25${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      if (res.status === 404) break; // no schedule yet
      if (!res.ok) return { segments, error: await helixError(res) };
      const j = await res.json();
      const segs = (j.data && j.data.segments) || [];
      let done = false;
      for (const s of segs) {
        const start = Date.parse(s.start_time);
        if (start > until) {
          done = true;
          break;
        }
        if (s.canceled_until) continue;
        const durationMin = Math.max(30, Math.min(1380, Math.round((Date.parse(s.end_time) - start) / 60000) || 180));
        const item = {
          start: s.start_time,
          durationMin,
          title: s.title,
          categoryId: s.category ? s.category.id : null,
          categoryName: s.category ? s.category.name : null,
          keepSegmentId: s.is_recurring ? null : s.id,
        };
        if (s.is_recurring) {
          const seriesKey = `${new Date(start).getUTCDay()}|${new Date(start).toISOString().slice(11, 16)}|${s.title}|${item.categoryId}`;
          if (!recurringIds.has(seriesKey)) recurringIds.set(seriesKey, s.id);
        }
        segments.push(item);
      }
      after = j.pagination && j.pagination.cursor;
      if (done || !after || !segs.length) break;
    }

    // The repeating series are NOT deleted here: calendar.js first creates
    // the individual weekly entries, and only if all of them made it onto
    // Twitch does it call deleteSeries — so a failure never leaves the
    // Twitch schedule empty.
    return {
      segments: segments.map((s) => ({ ...s, tag: guessTag(s.categoryName) })),
      recurringSeriesIds: [...recurringIds.values()],
    };
  },

  async deleteSeries(env, d, ids) {
    const t = await session(env, d);
    let deleted = 0;
    for (const id of ids) {
      const { res } = await helix(env, d, 'DELETE', `/schedule/segment?broadcaster_id=${t.userId}&id=${encodeURIComponent(id)}`);
      if (res.ok || res.status === 404) deleted++;
    }
    return deleted;
  },
};

// ---------- helpers ----------

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
