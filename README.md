# vibesbyvince.com

Single-page stream hub for VibesByVince. Plain HTML/CSS/JS, deployed as a
static site on Cloudflare Pages — push to `main` and it redeploys.

## Before first deploy — 1 thing left to fill in

- **Discord invite** — in `index.html`, find `id="discord-link"` and
  replace the `href="#"` with your real invite URL. Everything else
  (GitHub link, YouTube channel ID, Instagram, Bluesky, Govee affiliate
  link) is already filled in.

## Updating your "next stream" time

When you're offline, the status card shows a "next stream" line pulled from
`data/schedule.json`. Update it whenever your schedule changes:

```json
{
  "next": "Monday · 5:00 PM MST",
  "game": "Fortnite",
  "updated": "2026-08-31"
}
```

The "view schedule" link on that card always points to your real Twitch
schedule page (`twitch.tv/vibesbyvince/schedule`), so keep that set up on
Twitch itself for the full accurate calendar — this file is just the
one-line preview.

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
  `data/schedule.json` when offline. Fails silently if unreachable. The
  Twitch link card also picks up a small "live" badge when you're live.
- **Latest clip** — links straight to `decapi.me/twitch/clip/vibesbyvince`,
  which redirects to your most recent clip. No fetch, no API key.
- **Latest YouTube upload** — `functions/api/youtube.js` is a Cloudflare
  Pages Function that reads your channel's public RSS feed server-side
  (avoids browser CORS issues) and returns the newest video. It can't
  specifically tell Shorts apart from regular uploads — it just shows
  whatever's newest.
- **Latest TikTok** — reads `data/latest-tiktok.json` (see above).

## Local preview

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Note the `/api/youtube` function only
runs on Cloudflare (or via `wrangler pages dev`), so locally that card
will just show its fallback text.
