// VibesByVince — Twitch "app" access for public data (stream teams, clips).
//
// Uses the client-credentials flow with TWITCH_CLIENT_ID /
// TWITCH_CLIENT_SECRET (the same Twitch app as the calendar). An app token
// can only read public information; it never acts as Vince's account.
// The Twitch login used for the schedule sync lives in worker/twitch.js.

const HELIX = 'https://api.twitch.tv/helix';

let appToken = { token: null, exp: 0 };

export function appConfigured(env) {
  return !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
}

async function token(env) {
  if (appToken.token && appToken.exp - Date.now() > 300000) return appToken.token;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Twitch token: ${res.status}`);
  const j = await res.json();
  appToken = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return appToken.token;
}

// GET a Helix endpoint as the app; retries once with a fresh token on 401.
export async function appHelix(env, path) {
  let res = await fetch(`${HELIX}${path}`, {
    headers: { authorization: `Bearer ${await token(env)}`, 'client-id': env.TWITCH_CLIENT_ID },
  });
  if (res.status === 401) {
    appToken = { token: null, exp: 0 };
    res = await fetch(`${HELIX}${path}`, {
      headers: { authorization: `Bearer ${await token(env)}`, 'client-id': env.TWITCH_CLIENT_ID },
    });
  }
  if (!res.ok) throw new Error(`Twitch ${path.split('?')[0]}: ${res.status}`);
  return res.json();
}
