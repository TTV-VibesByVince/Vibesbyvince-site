# vibesbyvince.com

Single-page stream hub for VibesByVince. Plain HTML/CSS/JS, deployed on
Cloudflare Workers (static assets) — push to `main` and it redeploys.
`wrangler.jsonc` + `worker/index.js` handle the deploy config and the
dynamic routes (`/api/youtube`, `/api/schedule`, `/api/calendar/*`, `/api/tiktok`,
`/api/projects`, `/api/project-image/<repo>`, `/api/fortnite/*`, `/api/vibesmas/*`);
everything else is served directly as static files.

## Vibesmas Tournament (`/vibesmas`)

Fortnite Zero Build duos tournament on Saturday, December 12, 2026.

- `/vibesmas`: info, prizes, point system, rules and the approved duos.
  The hero plays `assets/video/vibesmas-loop.mp4` (muted loop).
- `/vibesmas/signup`: a duo signs up (duo name, Epic names, Twitch names
  for whoever streams, at least one Discord name, 21+ and rules boxes).
  Twitch names are checked against Twitch. Each duo gets a private status
  link (`/vibesmas/signup#k=<key>`, only a hash of the key is stored) to
  check approval, edit while not approved, or withdraw. Registration
  closes Dec 5, 11:59 PM MST; at most 40 approved duos.
- `/vibesmas/leaderboard`: live standings (refreshes every 30 s). Only
  games published in the admin count. Points: 1st 10, 2nd 8, 3rd 6, 4th 4,
  5th 2, +1 per duo kill; ties go to total kills.
- `/vibesmas/overlay`: OBS browser source (1920×1080, transparent).
  `?rows=5` sets how many duos show (3–10), `&side=left` moves the panel.
- `/vibesmas/admin`: approve / decline (with a note the duo sees),
  enter each game's placements and kills, publish games, set the status
  (before / live / 24-hour review / final), the game in progress and the
  outfit winner. Activity log on the side.
- Code: `worker/vibesmas.js` (tables `vibesmas_*` in the same D1 database,
  created automatically), `vibesmas.html`, `vibesmas/*.html`,
  `js/vibesmas*.js`, `css/vibesmas.css`. Tournament dates and the duo cap
  are in `TOURNAMENT` at the top of `worker/vibesmas.js`.

Setup:

1. **Admin login:** in Cloudflare Zero Trust → Access → Applications, edit
   the calendar admin application and add two more destinations:
   `vibesbyvince.com/vibesmas/admin` and `vibesbyvince.com/api/vibesmas/admin`.
   Same application means the same AUD tag and the same allowed email.
2. **Discord alerts (optional):** create a webhook on a private channel and
   save its URL as the secret `VIBESMAS_DISCORD_WEBHOOK`
   (Workers & Pages → vibesbyvince-site → Settings → Variables and Secrets).
   Each new or edited sign-up posts there with a link to the admin page.

## Stream schedule (`/calendar`)

The schedule lives on the site itself now. **Edit it only at
`/calendar/admin`**: every change is copied to the Twitch schedule
automatically (one way: site → Twitch; edits made directly on Twitch are
not read back).

- `/calendar` — public month view (list on phones), shown in each
  visitor's own time zone, plus an "Add to my calendar" feed at
  `/api/calendar/ics`.
- `/calendar/admin` — add / edit / delete streams, "repeat weekly for N
  weeks" (each week is its own entry), Twitch category search, Twitch
  sync status with Retry, and a one-time import from the old Twitch
  schedule + Google Calendar (repeating Twitch entries are split into
  individual weeks; the repeating series is only removed from Twitch once
  every weekly copy made it on).
- The homepage "next stream" card and the Fortnite page banner read from
  it via `/api/schedule`. Until the calendar has any streams, they still
  fall back to the Google Calendar feed (`CALENDAR_ICS_URL`).
- Code: `worker/calendar.js` (data, public + admin API, import),
  `worker/twitch.js` (Twitch sign-in + sync), `calendar.html`,
  `calendar/admin.html`, `js/calendar.js`, `js/calendar-admin.js`,
  `css/calendar.css`. Times are entered in Arizona time and stored in UTC.

### One-time setup (Cloudflare dashboard)

1. **Database:** Storage & Databases → D1 → Create → name it
   `vibesbyvince-calendar`. Put its Database ID in `wrangler.jsonc`
   (`d1_databases[0].database_id`). Tables are created automatically.
2. **Login for the admin page (Cloudflare Access / Zero Trust):** create a
   self-hosted application covering `vibesbyvince.com/calendar/admin` and
   `vibesbyvince.com/api/calendar/admin`, with a policy that allows only
   your email (one-time PIN). Then add Worker secrets:
   `ACCESS_TEAM_DOMAIN` (e.g. `yourteam.cloudflareaccess.com`),
   `ACCESS_AUD` (the application's Audience tag) and `ADMIN_EMAIL`.
   The Worker checks Access's signed token itself, so the admin API stays
   closed if any of these are missing or wrong.
3. **Twitch:** register an app at dev.twitch.tv/console with OAuth
   redirect URL
   `https://vibesbyvince.com/api/calendar/admin/twitch/callback`, then add
   Worker secrets `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`. Open
   `/calendar/admin` → **Connect Twitch** (asks only for "Manage your
   schedule"). Twitch only allows Affiliates/Partners to add one-off
   schedule entries.
4. In `/calendar/admin`, press **Import now** once.

Local testing: `npx wrangler dev` uses a local database; put
`DEV_ADMIN_BYPASS=true` in `.dev.vars` (git-ignored) to open the admin page
on `127.0.0.1` without Access. The bypass only works on localhost.

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
- **Latest clip** — `/api/clip` (`worker/clip.js`) finds the newest clip
  on the channel (last 7 days, then 30, then a year) using the Twitch app
  keys, and the card shows its thumbnail and title. Cached ~10 minutes.
  With no clips it links to `twitch.tv/vibesbyvince/clips`.
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

## Fortnite Hub (`/fortnite`)

`fortnite.html` + `css/fortnite.css` + `js/fortnite.js`, with its API in
`worker/fortnite.js`. Data comes from [fortnite-api.com](https://fortnite-api.com)
(unofficial; Epic has no public API), always fetched server-side and cached:

- **Item Shop** — `/api/fortnite/shop`, cached until the daily reset
  (00:00 UTC = 5:00 PM Arizona). No key needed.
- **Drop spot randomizer** — `/api/fortnite/map`, the current map and its
  named locations. No key needed. Marker positions use `MAP_FIT` in
  `worker/fortnite.js`; if markers drift after a big map change, re-fit it.
- **Stats lookup** — `/api/fortnite/stats`. Needs a free API key from
  fortnite-api.com stored as a Cloudflare **secret** named
  `FORTNITE_API_KEY` (same place as `CALENDAR_ICS_URL`). Without it the
  page says "being set up". Only players with public stats can be shown.
- **Images** — `/api/fortnite/img?u=…` passes fortnite-api.com images
  through the site; nothing else can be fetched through it.
- **Creator code** — `VibesByVince`, in `fortnite.html` (two places).
- **Challenges** — the `CHALLENGES` list in `js/fortnite.js`.

For local testing of the stats lookup, put `FORTNITE_API_KEY=...` in a
`.dev.vars` file (git-ignored) and run `npx wrangler dev`.

## Stream teams raid finder (`/streamteams`)

`streamteams.html` + `css/streamteams.css` + `js/streamteams.js`, API in
`worker/streamteams.js`. Shows who's live across the Twitch teams in
`TEAMS` (edit that list to add or remove a team), with team, game, search
and sort filters, plus a "Copy /raid" button per streamer. Members on
several teams appear once with every team badge; `vibesbyvince` itself is
left out.

- Uses a Twitch *app* token from the same `TWITCH_CLIENT_ID` /
  `TWITCH_CLIENT_SECRET` as the calendar (public data only; it doesn't use
  your Twitch login).
- Live list cached 60 s at the edge, team rosters 6 h. Avatars and live
  previews pass through `/api/streamteams/img` (static-cdn.jtvnw.net only).
- Local design testing without Twitch keys: `STREAMTEAMS_SAMPLE=true` in
  `.dev.vars` (only works on localhost).

## The secret (easter egg)

Typing `vibes` or `matrix` anywhere (not while typing in a box), or tapping
the homepage banner / a page's title 5 times quickly on a phone, plays
`assets/video/vibes-matrix.mp4` full screen with sound, then offers
**Matrix mode**: the site in green-on-black with falling code
(`js/easter-egg.js`, `css/matrix.css`). Matrix mode lasts for the visit
(sessionStorage) until "exit matrix mode". Esc / Skip stops the video;
reduced-motion visitors are asked before it plays and get still code rain.
To change the secret words, edit `WORDS` in `js/easter-egg.js`. Tap
targets are elements with `data-egg-tap`.

## Local preview


```
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Note the `/api/*` routes only
run on Cloudflare (or via `npx wrangler dev`), so locally those cards
will just show their fallback text.
