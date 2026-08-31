// VibesByVince — small progressive-enhancement scripts.
// Everything here fails silently: if an API is down or blocked, the page
// just keeps its default static state instead of breaking.

document.getElementById('year').textContent = new Date().getFullYear();

const TWITCH_CHANNEL = 'vibesbyvince';

/* ---------- Twitch live status + "currently playing" / "next stream" ---------- */
// Uses DecAPI (https://decapi.me) — a free, keyless helper API built for
// exactly this kind of stream-overlay use case. No auth, no secrets.
// When offline, "next stream" comes from data/schedule.json, which you
// update by hand (see README) — the full accurate schedule always lives
// on Twitch itself, linked via the CTA.

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  return (await res.text()).trim();
}

async function updateLiveStatus() {
  const card = document.getElementById('status-card');
  const dot = document.getElementById('live-dot');
  const stateEl = document.getElementById('status-state');
  const detailEl = document.getElementById('status-detail');
  const ctaEl = document.getElementById('status-cta');
  const twitchCard = document.getElementById('linkcard-twitch');
  const liveBadge = document.getElementById('linkcard-live-badge');
  if (!card || !stateEl) return;

  try {
    const uptime = await fetchText(
      `https://decapi.me/twitch/uptime/${TWITCH_CHANNEL}?offline_msg=offline`
    );
    const isLive = !/offline|error/i.test(uptime);

    if (isLive) {
      card.classList.add('is-live');
      card.classList.remove('is-offline');
      dot.classList.add('is-on');
      stateEl.textContent = 'LIVE NOW';
      ctaEl.textContent = 'watch live →';
      ctaEl.href = `https://twitch.tv/${TWITCH_CHANNEL}`;
      twitchCard?.classList.add('is-live');
      if (liveBadge) liveBadge.hidden = false;

      try {
        const game = await fetchText(`https://decapi.me/twitch/game/${TWITCH_CHANNEL}`);
        detailEl.textContent = game && !/error/i.test(game) ? game : `live for ${uptime}`;
      } catch {
        detailEl.textContent = `live for ${uptime}`;
      }
    } else {
      card.classList.add('is-offline');
      card.classList.remove('is-live');
      dot.classList.remove('is-on');
      stateEl.textContent = 'offline right now';
      ctaEl.textContent = 'view schedule →';
      ctaEl.href = `https://twitch.tv/${TWITCH_CHANNEL}/schedule`;
      twitchCard?.classList.remove('is-live');
      if (liveBadge) liveBadge.hidden = true;

      try {
        const res = await fetch('data/schedule.json', { cache: 'no-store' });
        const sched = await res.json();
        detailEl.textContent = sched.next
          ? `next stream · ${sched.next}${sched.game ? ' · ' + sched.game : ''}`
          : ' ';
      } catch {
        detailEl.textContent = ' ';
      }
    }
  } catch (err) {
    // API unreachable — leave whatever state is already showing.
  }
}

updateLiveStatus();
setInterval(updateLiveStatus, 60000);

/* ---------- Latest YouTube upload ---------- */
// Backed by /functions/api/youtube.js, a Cloudflare Pages Function that
// reads the channel's public RSS feed server-side (avoids browser CORS
// issues with youtube.com) and returns the newest video as JSON.

async function updateLatestYouTube() {
  const card = document.getElementById('drop-youtube');
  const titleEl = document.getElementById('drop-youtube-title');
  const thumbEl = document.getElementById('drop-youtube-thumb');
  const iconEl = document.getElementById('drop-youtube-icon');
  if (!card || !titleEl) return;

  try {
    const res = await fetch('/api/youtube', { cache: 'no-store' });
    const data = await res.json();
    if (data.error || !data.url) throw new Error('no video');

    card.href = data.url;
    titleEl.textContent = data.title || 'watch latest video';
    if (thumbEl && data.thumbnail) {
      thumbEl.onload = () => {
        thumbEl.hidden = false;
        if (iconEl) iconEl.hidden = true;
      };
      thumbEl.onerror = () => {
        thumbEl.hidden = true;
      };
      thumbEl.src = data.thumbnail;
    }
  } catch (err) {
    titleEl.textContent = 'watch on youtube';
  }
}

updateLatestYouTube();

/* ---------- Latest TikTok post ---------- */
// Manually updated: edit data/latest-tiktok.json and push whenever you
// want to feature a new post. No scraping, nothing to break.

async function updateLatestTikTok() {
  const card = document.getElementById('drop-tiktok');
  const titleEl = document.getElementById('drop-tiktok-title');
  if (!card || !titleEl) return;

  try {
    const res = await fetch('data/latest-tiktok.json', { cache: 'no-store' });
    const data = await res.json();
    if (!data.url) throw new Error('no post configured');

    card.href = data.url;
    titleEl.textContent = data.caption || 'watch latest tiktok';
  } catch (err) {
    titleEl.textContent = 'watch on tiktok';
  }
}

updateLatestTikTok();
