# vibesbyvince.com

Single-page stream hub for VibesByVince. Plain HTML/CSS/JS, deployed on
Cloudflare Workers (static assets) — push to `main` and it redeploys.
`wrangler.jsonc` + `worker/index.js` handle the deploy config and the one
dynamic route (`/api/youtube`); everything else is served directly as
static files.

## Before first deploy — 1 thing left to fill in

- **Discord invite** — in `index.html`, find `id="discord-link"` and
  replace the `href="#"` with your real invite URL. Everything else
  (GitHub link, YouTube channel ID, Instagram, Bluesky, Govee affiliate
  link) is already filled in.

## Updating your "next stream" time

When you're offline, the status card shows a "next stream" line pulled
automatically from a public Google Calendar. Just add/edit events on that
calendar — nothing to touch in the repo, nothing to redeploy.

**One-time setup (already done, documented here for reference):**

1. Made a public Google Calendar dedicated to the stream schedule (keep it
   dedicated — "public" applies to the whole calendar).
2. Grabbed its **secret address in iCal format** from Calendar → Settings
   and sharing → Integrate calendar.
3. Set that URL as a Cloudflare **secret** named `CALENDAR_ICS_URL` on this
   Worker (Cloudflare dashboard → this project → Settings/Bindings →
   Variables and Secrets → Add → type "Secret"). It's deliberately NOT
   stored in this repo, since the repo is public and that URL lets anyone
   holding it read your calendar's event details.
4. `worker/index.js` reads `env.CALENDAR_ICS_URL`, fetches the feed, and
   returns the earliest future event as JSON at `/api/schedule`.

Because it's a secret (not a plain `vars` entry in `wrangler.jsonc`), it
persists across every future git-triggered redeploy automatically — no
need to re-enter it.

The "view schedule" link on the status card always points to your real
Twitch schedule page (`twitch.tv/vibesbyvince/schedule`) too, so keep that
updated on Twitch for anyone who wants the full calendar view.

## Updating your "latest TikTok" card

There's no free public API for this, so it's a one-line manual update.
Whenever you want to feature a new TikTok post, edit `data/latest-tiktok.json`:

```json
{
  "url": "https://www.tiktok.com/@vibesbyvince/video/1234567890123456789",
  "caption": "short caption to show on the card",
  "updated": "2026-08-30"
}
```

Commit and push — that's it.

## How the dynamic bits work

- **Live status card** — client-side fetch to [DecAPI](https://decapi.me),
  a free keyless helper API built for stream overlays. Polls every 60s.
  Shows your current game when live, or the next-stream preview from
  `/api/schedule` (your Google Calendar, see above) when offline. Fails
  silently if unreachable. The Twitch link card also picks up a small
  "live" badge when you're live.
- **Latest clip** — links straight to `decapi.me/twitch/clip/vibesbyvince`,
  which redirects to your most recent clip. No fetch, no API key.
- **Latest YouTube upload** — `worker/index.js` handles requests to
  `/api/youtube` by reading your channel's public RSS feed server-side
  (avoids browser CORS issues) and returning the newest video. It can't
  specifically tell Shorts apart from regular uploads — it just shows
  whatever's newest. Every other URL on the site bypasses this script
  entirely and is served straight from the static files (see
  `run_worker_first` in `wrangler.jsonc`).
- **Latest TikTok** — reads `data/latest-tiktok.json` (see above).

## Local preview. 


```
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Note the `/api/youtube` route only
runs on Cloudflare (or via `npx wrangler dev`), so locally that card
will just show its fallback text.
