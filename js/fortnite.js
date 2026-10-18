// VibesByVince — Fortnite Hub (/fortnite).
// Like the homepage, everything fails quietly: if a data source is down,
// that section shows a short message instead of breaking the page.

const TWITCH_CHANNEL = 'vibesbyvince';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Makes a group of .tab buttons behave like a single-choice switch.
function tabGroup(container, attr, onChange) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn || !container.contains(btn)) return;
    for (const b of container.querySelectorAll('.tab')) {
      const on = b === btn;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    onChange(btn.dataset[attr]);
  });
  for (const b of container.querySelectorAll('.tab')) {
    b.setAttribute('aria-pressed', b.classList.contains('is-on') ? 'true' : 'false');
  }
}

/* ---------- live / next-stream banner ---------- */

async function updateLiveBanner() {
  try {
    const uptime = (await (await fetch(`https://decapi.me/twitch/uptime/${TWITCH_CHANNEL}?offline_msg=offline`, { cache: 'no-store' })).text()).trim();
    const isLive = !/offline|error/i.test(uptime);

    if (isLive) {
      let game = '';
      try {
        game = (await (await fetch(`https://decapi.me/twitch/game/${TWITCH_CHANNEL}`, { cache: 'no-store' })).text()).trim();
      } catch {}
      $('live-banner-text').textContent = /fortnite/i.test(game)
        ? 'Vince is live in Fortnite right now'
        : game && !/error/i.test(game)
          ? `Vince is live right now: ${game}`
          : 'Vince is live right now';
      $('live-banner').hidden = false;
      $('next-banner').hidden = true;
      return;
    }

    $('live-banner').hidden = true;
    const sched = await (await fetch('/api/schedule', { cache: 'no-store' })).json();
    if (sched && sched.next) {
      $('next-banner-text').textContent = `Offline · next stream ${sched.next}${sched.game ? ' · ' + sched.game : ''}`;
      $('next-banner').hidden = false;
    }
  } catch {
    // leave both banners hidden
  }
}

updateLiveBanner();
setInterval(updateLiveBanner, 60000);

/* ---------- copy creator code ---------- */

$('copy-code').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const code = btn.dataset.code;
  try {
    await navigator.clipboard.writeText(code);
    btn.textContent = 'Copied!';
  } catch {
    btn.textContent = code; // clipboard blocked: at least show it
  }
  setTimeout(() => (btn.textContent = 'Copy code'), 1800);
});

/* ---------- stats lookup ---------- */

const statsState = { name: '', platform: 'epic', window: 'lifetime', mode: 'overall', data: null };
const PLATFORM_NAMES = { epic: 'Epic', psn: 'PlayStation', xbl: 'Xbox' };

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtDec = (n, d = 2) => Number(n || 0).toFixed(d);

function renderStats() {
  const { data, mode } = statsState;
  const grid = $('stats-grid');
  grid.textContent = '';
  const m = data && data.modes && data.modes[mode];
  if (!m) {
    grid.appendChild(el('p', 'stats-message', 'No matches in this mode yet.'));
    return;
  }
  const rows = [
    [fmtInt(m.wins), 'Wins'],
    [fmtInt(m.matches), 'Matches'],
    [`${fmtDec(m.winRate, 1)}%`, 'Win rate'],
    [fmtDec(m.kd), 'K/D'],
    [fmtInt(m.kills), 'Eliminations'],
    [fmtDec(m.killsPerMatch), 'Elims per match'],
    [fmtInt(m.playersOutlived), 'Players outlived'],
    [fmtInt(m.minutesPlayed / 60), 'Hours played'],
  ];
  for (const [value, label] of rows) {
    const box = el('div', 'stat');
    box.append(el('b', '', value), el('span', '', label));
    grid.appendChild(box);
  }
}

async function lookupStats() {
  const msg = $('stats-message');
  const btn = $('stats-submit');
  msg.classList.remove('is-error');
  msg.textContent = 'Looking up…';
  btn.disabled = true;

  try {
    const q = new URLSearchParams({ name: statsState.name, platform: statsState.platform, window: statsState.window });
    const data = await (await fetch(`/api/fortnite/stats?${q}`)).json();

    if (data.error) {
      const errors = {
        private: `${statsState.name}'s stats are private. In Fortnite: Settings › Account and Privacy › turn on "Show on Career Leaderboard", then try again.`,
        not_found: `Couldn't find "${statsState.name}" on ${PLATFORM_NAMES[statsState.platform]}. Check the spelling, or try another platform.`,
        bad_name: 'Usernames are 3 to 32 characters.',
        not_configured: 'Stats lookup is being set up. Check back soon!',
      };
      msg.textContent = errors[data.error] || 'Stats are unavailable right now. Try again in a minute.';
      msg.classList.add('is-error');
      $('stats-card').hidden = true;
      return;
    }

    statsState.data = data;
    msg.textContent = '';
    $('stats-player').textContent = data.name || statsState.name;
    $('stats-avatar').textContent = (data.name || statsState.name).charAt(0);
    $('stats-meta').textContent = [
      PLATFORM_NAMES[data.platform] || '',
      data.battlePassLevel ? `Battle Pass level ${data.battlePassLevel}` : '',
    ].filter(Boolean).join(' · ');
    renderStats();
    $('stats-card').hidden = false;
  } catch {
    msg.textContent = 'Stats are unavailable right now. Try again in a minute.';
    msg.classList.add('is-error');
  } finally {
    btn.disabled = false;
  }
}

$('stats-form').addEventListener('submit', (e) => {
  e.preventDefault();
  statsState.name = $('stats-name').value.trim();
  statsState.platform = $('stats-platform').value;
  if (statsState.name.length < 3) return;
  lookupStats();
});

tabGroup($('stats-modes'), 'mode', (mode) => {
  statsState.mode = mode;
  renderStats();
});

tabGroup($('stats-window'), 'window', (win) => {
  statsState.window = win;
  if (statsState.name) lookupStats();
});

/* ---------- item shop ---------- */

const shopState = { items: [], filter: 'all', vbuck: null, nextReset: null };

function matchesFilter(item, filter) {
  if (filter === 'all') return true;
  if (filter === 'new') return item.isNew;
  if (filter === 'leaving') return item.leavingTonight;
  return item.typeKey === filter;
}

function renderShop() {
  const wrap = $('shop-sections');
  const msg = $('shop-message');
  wrap.textContent = '';

  const items = shopState.items.filter((i) => matchesFilter(i, shopState.filter));
  if (!items.length) {
    msg.textContent = shopState.items.length ? 'Nothing in this category today.' : msg.textContent;
    return;
  }
  msg.textContent = `${items.length} item${items.length === 1 ? '' : 's'} in the shop today.`;

  // keep the shop's own section order
  const sections = new Map();
  for (const item of items) {
    if (!sections.has(item.section)) sections.set(item.section, []);
    sections.get(item.section).push(item);
  }

  for (const [name, list] of sections) {
    const section = el('div', 'shop-section');
    section.appendChild(el('h3', 'shop-section__title', name));
    const grid = el('div', 'shop');

    for (const item of list) {
      // series (Icon, Gaming Legends, Marvel…) wins over plain rarity for the tile colour
      const tint = (item.series || item.rarity || 'common').replace(/\s+/g, '').replace(/series$/i, '').toLowerCase();
      const card = el('div', `item r-${tint}`);
      const art = el('div', 'item__art');
      if (item.image) {
        const img = el('img');
        img.src = item.image;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.onerror = () => img.remove();
        art.appendChild(img);
      }
      if (item.isNew) art.appendChild(el('span', 'item__badge', 'New today'));

      const body = el('div', 'item__body');
      body.appendChild(el('span', 'item__rarity', [item.rarityName, item.type].filter(Boolean).join(' · ')));
      body.appendChild(el('span', 'item__name', item.name));

      const price = el('span', 'item__price');
      if (shopState.vbuck) {
        const icon = el('img');
        icon.src = shopState.vbuck;
        icon.alt = 'V-Bucks';
        icon.width = 16;
        icon.height = 16;
        price.appendChild(icon);
      }
      price.appendChild(document.createTextNode(fmtInt(item.price)));
      if (item.regularPrice > item.price) {
        price.appendChild(document.createTextNode(' '));
        price.appendChild(el('s', '', fmtInt(item.regularPrice)));
      }
      body.appendChild(price);

      card.append(art, body);
      grid.appendChild(card);
    }

    section.appendChild(grid);
    wrap.appendChild(section);
  }
}

function tickTimer() {
  if (!shopState.nextReset) return;
  let left = Math.max(0, Math.floor((shopState.nextReset - Date.now()) / 1000));
  if (left === 0) {
    $('shop-timer').textContent = 'now!';
    return;
  }
  const h = String(Math.floor(left / 3600)).padStart(2, '0');
  const m = String(Math.floor((left % 3600) / 60)).padStart(2, '0');
  const s = String(left % 60).padStart(2, '0');
  $('shop-timer').textContent = `${h}:${m}:${s}`;
}

async function loadShop() {
  try {
    const data = await (await fetch('/api/fortnite/shop')).json();
    if (data.error || !Array.isArray(data.items)) throw new Error('no shop');
    shopState.items = data.items;
    shopState.vbuck = data.vbuckIcon;
    shopState.nextReset = Date.parse(data.nextReset);
    renderShop();
    tickTimer();
    setInterval(tickTimer, 1000);
  } catch {
    $('shop-message').textContent = "Today's shop couldn't be loaded. Try again in a bit.";
  }
}

tabGroup($('shop-filters'), 'filter', (filter) => {
  shopState.filter = filter;
  renderShop();
});

loadShop();

/* ---------- drop spot randomizer ---------- */

const dropState = { spots: [], last: -1 };

function spinDrop() {
  const majorOnly = $('drop-major').checked;
  const pool = dropState.spots.filter((s) => !majorOnly || s.major);
  if (!pool.length) return;
  let i = Math.floor(Math.random() * pool.length);
  if (pool.length > 1 && pool[i] === dropState.spots[dropState.last]) i = (i + 1) % pool.length;
  const spot = pool[i];
  dropState.last = dropState.spots.indexOf(spot);
  $('drop-name').textContent = spot.name;
  const marker = $('drop-marker');
  marker.style.left = `${spot.left * 100}%`;
  marker.style.top = `${spot.top * 100}%`;
  marker.hidden = false;
}

async function loadMap() {
  try {
    const data = await (await fetch('/api/fortnite/map')).json();
    if (!Array.isArray(data.spots) || !data.spots.length) throw new Error('no map');
    dropState.spots = data.spots;
    if (data.image) {
      const img = $('drop-map-img');
      img.onload = () => (img.hidden = false);
      img.src = data.image;
    }
  } catch {
    $('drop-name').textContent = 'Map unavailable right now';
    $('drop-spin').disabled = true;
  }
}

$('drop-spin').addEventListener('click', spinDrop);
loadMap();

/* ---------- challenge roulette ---------- */

const CHALLENGES = [
  ['any', 'Loadout', 'Gray and green weapons only'],
  ['any', 'Build rules', 'No building the whole match'],
  ['any', 'Landing', 'Land at the first spot the Battle Bus flies over'],
  ['any', 'Loadout', 'Keep the first weapon you pick up, all game'],
  ['any', 'Healing', 'No medkits or bandages'],
  ['any', 'Chaos', 'Emote after every elimination'],
  ['any', 'Chat', 'Chat picks your drop spot'],
  ['any', 'Loadout', 'Pistols only'],
  ['any', 'Movement', 'No vehicles this match'],
  ['any', 'Loot', "Only loot from chests, no floor loot"],
  ['any', 'Landing', 'Drop at the very last second the bus allows'],
  ['any', 'Loadout', 'Only three inventory slots allowed'],
  ['any', 'Chaos', 'Every time you take damage, crouch-walk for 5 seconds'],
  ['solo', 'Solo', 'Win without eliminating anyone'],
  ['solo', 'Solo', 'Get 5 eliminations before the first storm closes'],
  ['solo', 'Solo', 'Reach the top 10 using only what\'s in the first chest you open'],
  ['squad', 'Squads', 'Everyone uses the same weapon type'],
  ['squad', 'Squads', 'Whoever gets the first elimination picks everyone\'s loadout'],
  ['squad', 'Squads', 'Land at four different spots and regroup'],
  ['squad', 'Squads', 'Only the squad leader can open chests'],
];

const chalState = { filter: 'any', last: -1 };

function spinChallenge() {
  const pool = CHALLENGES.filter(([type]) => chalState.filter === 'any' || type === 'any' || type === chalState.filter);
  let i = Math.floor(Math.random() * pool.length);
  if (pool.length > 1 && CHALLENGES.indexOf(pool[i]) === chalState.last) i = (i + 1) % pool.length;
  chalState.last = CHALLENGES.indexOf(pool[i]);
  $('chal-tag').textContent = pool[i][1];
  $('chal-text').textContent = pool[i][2];
}

tabGroup($('chal-filters'), 'chal', (filter) => {
  chalState.filter = filter;
});

$('chal-spin').addEventListener('click', spinChallenge);
