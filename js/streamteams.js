// VibesByVince — stream teams raid finder (/streamteams).
// Pulls /api/streamteams every minute and filters it in the browser.

const $ = (id) => document.getElementById(id);
$('year').textContent = new Date().getFullYear();

const state = { data: null, team: '', game: '', sort: 'viewers', q: '', copied: '' };

// remember the visitor's last team / sort choice (nice-to-have only)
try {
  const saved = JSON.parse(localStorage.getItem('vbv-streamteams') || '{}');
  if (saved.sort) state.sort = saved.sort;
  if (saved.team) state.team = saved.team;
} catch {}
function remember() {
  try {
    localStorage.setItem('vbv-streamteams', JSON.stringify({ sort: state.sort, team: state.team }));
  } catch {}
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

const fmtUp = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const fmtViewers = (n) => `${n.toLocaleString()} viewer${n === 1 ? '' : 's'}`;

function teamIndex(slug) {
  return state.data ? state.data.teams.findIndex((t) => t.slug === slug) : 0;
}
function teamName(slug) {
  const t = state.data && state.data.teams.find((x) => x.slug === slug);
  return t ? t.name : slug;
}

function renderChips() {
  const wrap = $('team-chips');
  wrap.textContent = '';
  const live = state.data.live;
  const chips = [{ slug: '', name: 'All teams', n: live.length }].concat(
    state.data.teams.map((t) => ({ slug: t.slug, name: t.name, n: live.filter((s) => s.teams.includes(t.slug)).length }))
  );
  for (const c of chips) {
    const b = el('button', `st-chip${c.slug ? ` team-${teamIndex(c.slug)}` : ''}${state.team === c.slug ? ' is-on' : ''}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', state.team === c.slug ? 'true' : 'false');
    if (c.slug) b.appendChild(el('i'));
    b.append(document.createTextNode(c.name + ' '), el('span', 'n', `· ${c.n}`));
    b.addEventListener('click', () => {
      state.team = c.slug;
      remember();
      render();
    });
    wrap.appendChild(b);
  }
}

function renderGames() {
  const sel = $('game-filter');
  const games = [...new Set(state.data.live.map((s) => s.game))].sort((a, b) => a.localeCompare(b));
  if (state.game && !games.includes(state.game)) games.unshift(state.game); // keep the pick even if nobody's on it now
  sel.textContent = '';
  sel.appendChild(new Option('All games', ''));
  for (const g of games) {
    const n = state.data.live.filter((s) => s.game === g).length;
    sel.appendChild(new Option(`${g} (${n})`, g));
  }
  sel.value = state.game;
}

function card(s) {
  const c = el('article', 'st-card');

  const thumb = el('a', 'st-thumb');
  thumb.href = `https://twitch.tv/${s.login}`;
  thumb.target = '_blank';
  thumb.rel = 'noopener';
  thumb.setAttribute('aria-label', `Watch ${s.name} on Twitch`);
  if (s.preview) {
    const img = el('img');
    img.src = s.preview;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => img.remove();
    thumb.appendChild(img);
  }
  thumb.append(
    el('span', 'st-badge st-badge--live', 'LIVE'),
    el('span', 'st-badge st-badge--viewers', fmtViewers(s.viewers)),
    el('span', 'st-badge st-badge--up', `live ${fmtUp(s.startedAt)}`)
  );

  const body = el('div', 'st-body');
  const who = el('div', 'st-who');
  if (s.avatar) {
    const av = el('img', 'st-avatar');
    av.src = s.avatar;
    av.alt = '';
    av.loading = 'lazy';
    who.appendChild(av);
  } else {
    who.appendChild(el('span', 'st-avatar'));
  }
  const names = el('div');
  names.style.minWidth = '0';
  names.append(el('span', 'st-name', s.name), el('span', 'st-game', s.game));
  who.appendChild(names);

  const teams = el('div', 'st-teams');
  for (const slug of s.teams) teams.appendChild(el('span', `st-team team-${teamIndex(slug)}`, teamName(slug)));

  const actions = el('div', 'st-actions');
  const copy = el('button', 'btn-primary', state.copied === s.login ? 'Copied!' : 'Copy /raid');
  copy.type = 'button';
  copy.title = `/raid ${s.login}`;
  copy.setAttribute('aria-label', `Copy the raid command for ${s.name}`);
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`/raid ${s.login}`);
      state.copied = s.login;
      copy.textContent = 'Copied!';
      setTimeout(() => {
        if (state.copied === s.login) state.copied = '';
        copy.textContent = 'Copy /raid';
      }, 2000);
    } catch {
      copy.textContent = `/raid ${s.login}`;
    }
  });
  const watch = el('a', 'ghost-btn', 'Watch ↗');
  watch.href = `https://twitch.tv/${s.login}`;
  watch.target = '_blank';
  watch.rel = 'noopener';
  actions.append(copy, watch);

  body.append(who, el('p', 'st-title', s.title), teams, actions);
  c.append(thumb, body);
  return c;
}

function render() {
  if (!state.data) return;
  renderChips();
  renderGames();

  const q = state.q.toLowerCase();
  let list = state.data.live.filter(
    (s) =>
      (!state.team || s.teams.includes(state.team)) &&
      (!state.game || s.game === state.game) &&
      (!q || s.name.toLowerCase().includes(q) || s.login.includes(q))
  );
  const sorts = {
    viewers: (a, b) => b.viewers - a.viewers,
    small: (a, b) => a.viewers - b.viewers,
    long: (a, b) => a.startedAt.localeCompare(b.startedAt),
    new: (a, b) => b.startedAt.localeCompare(a.startedAt),
  };
  list = list.slice().sort(sorts[state.sort] || sorts.viewers);

  const grid = $('grid');
  grid.textContent = '';
  for (const s of list) grid.appendChild(card(s));

  const where = [state.team ? `in ${teamName(state.team)}` : '', state.game ? `playing ${state.game}` : ''].filter(Boolean).join(' ');
  $('summary').textContent = `${list.length} live${where ? ' ' + where : ''}`;
  const empty = $('empty');
  empty.hidden = list.length > 0;
  empty.textContent = state.data.live.length
    ? 'Nobody matching that is live right now. Try "All games" or another team.'
    : 'Nobody from the teams is live right now. Check back in a bit!';

  // offline roster
  const off = state.data.offline.filter((m) => (!state.team || m.teams.includes(state.team)) && (!q || m.name.toLowerCase().includes(q)));
  $('offline-box').hidden = off.length === 0;
  $('offline-summary').textContent = `Offline right now (${off.length})`;
  const ol = $('offline-list');
  ol.textContent = '';
  for (const m of off) {
    const row = el('div', `st-off team-${teamIndex(m.teams[0])}`);
    const a = el('a', '', m.name);
    a.href = `https://twitch.tv/${m.login}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = m.teams.map(teamName).join(', ');
    row.append(el('i'), a);
    ol.appendChild(row);
  }
}

async function load() {
  const upd = $('updated');
  try {
    const res = await fetch('/api/streamteams', { cache: 'no-store' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.data = data;
    if (state.team && !data.teams.some((t) => t.slug === state.team)) state.team = '';
    $('live-count').textContent = data.live.length;
    $('team-count').textContent = data.teams.length;
    upd.classList.remove('is-stale');
    upd.lastChild.textContent = `updated ${new Date(data.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · refreshes every minute`;
    render();
  } catch {
    upd.classList.add('is-stale');
    upd.lastChild.textContent = state.data ? "couldn't refresh, showing the last list" : 'Twitch info is unavailable right now. Try again in a minute.';
    if (!state.data) {
      $('empty').hidden = false;
      $('empty').textContent = 'Twitch info is unavailable right now. Try again in a minute.';
    }
  }
}

$('game-filter').addEventListener('change', (e) => {
  state.game = e.target.value;
  render();
});
$('sort').value = state.sort;
$('sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  remember();
  render();
});
$('search').addEventListener('input', (e) => {
  state.q = e.target.value.trim();
  render();
});

load();
setInterval(load, 60000);
