# vibesbyvince.com

Single-page stream hub for VibesByVince. Plain HTML/CSS/JS, deployed on
Cloudflare Workers (static assets) — push to `main` and it redeploys.
`wrangler.jsonc` + `worker/index.js` handle the deploy config and the
dynamic routes (`/api/youtube`, `/api/schedule`, `/api/tiktok`,
`/api/projects`, `/api/project-image/<repo>`);
everything else is served directly as static files.

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

There's no free keyless "latest video" feed for TikTok, so you pick the
video. Open it on TikTok, copy its link, and paste it into
`data/latest-tiktok.json`:

```json
{
  "url": "https://www.tiktok.com/@vibesbyvince/video/1234567890123456789",
  "caption": ""
}
```

Commit and push. The full `tiktok.com/@vibesbyvince/video/...` link is
needed (short `vm.tiktok.com` share links won't work). Leave `caption`
empty to use the TikTok's own caption, or fill it in to override it.
`/api/tiktok` looks up the caption and cover image through TikTok's
public oEmbed endpoint. With `url` empty, the card just links to the
profile.

## How the dynamic bits work

- **Live status card** — client-side fetch to [DecAPI](https://decapi.me),
  a free keyless helper API built for stream overlays. Polls every 60s.
  Shows your current game when live, or the next-stream preview from
  `/api/schedule` (your Google Calendar, see above) when offline. Fails
  silently if unreachable. The Twitch link card also picks up a small
  "live" badge when you're live.
- **Latest clips** — links to `twitch.tv/vibesbyvince/clips`. (It used to
  point at DecAPI's clip endpoint, which now returns a 404.)
- **Latest YouTube upload** — `worker/index.js` handles requests to
  `/api/youtube` by reading your channel's public RSS feed server-side
  (avoids browser CORS issues) and returning the newest video. It can't
  specifically tell Shorts apart from regular uploads — it just shows
  whatever's newest. Every other URL on the site bypasses this script
  entirely and is served straight from the static files (see
  `run_worker_first` in `wrangler.jsonc`).
- **Latest TikTok** — `/api/tiktok` reads `data/latest-tiktok.json` and
  adds the caption and cover image from TikTok's oEmbed (see above).
- **Vibes Lab** — each card's description and preview image come from the
  GitHub repo itself (its description and social preview image), via
  `/api/projects` and `/api/project-image/<repo>`. Edit them on GitHub and
  the site follows within ~6 hours. Images are passed through the Worker so
  visitors never contact GitHub. To add a project, add its repo name to
  `PROJECT_REPOS` in `worker/index.js` and add a card in `index.html`.
- **Fonts** — Inter and Rajdhani are self-hosted in `assets/fonts`
  (SIL Open Font License, licence files alongside), so the page never
  contacts Google Fonts.
- **Privacy** — `privacy.html` describes exactly what the page loads.
  Update it if you ever add analytics, embeds, forms or cookies.
- **404 page** — unknown URLs get `404.html` (`not_found_handling` in
  `wrangler.jsonc`).

## Local preview


```
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Note the `/api/*` routes only
run on Cloudflare (or via `npx wrangler dev`), so locally those cards
will just show their fallback text.
