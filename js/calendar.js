// VibesByVince — public stream calendar (/calendar).
// Shows a month at a time in the visitor's own time zone. Desktop gets a
// month grid, phones get a list (CSS picks which one shows).

const $ = (id) => document.getElementById(id);
document.getElementById('year').textContent = new Date().getFullYear();

const TAG_NAMES = { fortnite: 'Fortnite', horror: 'Horror', variety: 'Variety', special: 'Special' };
const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const viewerIsArizona = new Intl.DateTimeFormat('en-US', { timeZone: viewerTz, timeZoneName: 'short' })
  .format(new Date()) === new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', timeZoneName: 'short' }).format(new Date());

const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtAz = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix' });
const fmtDay = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

const today = new Date();
const state = { year: today.getFullYear(), month: today.getMonth(), events: [], next: null };

function whenText(ev) {
  const s = new Date(ev.start);
  let t = `${fmtDay(s)} · ${fmtTime(s)}`;
  if (!viewerIsArizona) t += ` (${fmtAz(s)} Arizona)`;
  return t;
}

function showDetail(ev) {
  $('detail-title').textContent = ev.title;
  $('detail-when').textContent = `${whenText(ev)}${ev.category ? ' · ' + ev.category : ''}`;
  $('cal-detail').className = `cal-detail t-${ev.tag}`;
  $('cal-detail').hidden = false;
}

function render() {
  const { year, month, events, next } = state;
  const first = new Date(year, month, 1);
  $('month-name').textContent = first.toLocaleDateString([], { month: 'long', year: 'numeric' });

  // group events by local date
  const byDay = new Map();
  for (const ev of events) {
    const s = new Date(ev.start);
    const key = `${s.getFullYear()}-${s.getMonth()}-${s.getDate()}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  // ---- grid ----
  const grid = $('cal-grid');
  grid.textContent = '';
  const startOffset = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  const now = Date.now();

  for (let i = 0; i < cells; i++) {
    const date = new Date(year, month, 1 - startOffset + i);
    const inMonth = date.getMonth() === month;
    const isToday = date.toDateString() === today.toDateString();
    const cell = el('div', `cal-cell${inMonth ? '' : ' is-out'}${isToday ? ' is-today' : ''}`);
    cell.appendChild(el('span', 'cal-num', String(date.getDate())));
    const list = byDay.get(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`) || [];
    for (const ev of list) {
      const s = new Date(ev.start);
      const b = el('button', `cal-ev t-${ev.tag}${s.getTime() + ev.durationMin * 60000 < now ? ' is-past' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-label', `${ev.title}, ${whenText(ev)}`);
      b.append(el('b', '', fmtTime(s)), el('span', '', ev.title));
      b.addEventListener('click', () => showDetail(ev));
      cell.appendChild(b);
    }
    grid.appendChild(cell);
  }

  // ---- list (phones) ----
  const listEl = $('cal-list');
  listEl.textContent = '';
  const monthEvents = events.filter((ev) => new Date(ev.start).getMonth() === month && new Date(ev.start).getFullYear() === year);
  let lastWeek = null;
  for (const ev of monthEvents) {
    const s = new Date(ev.start);
    const weekStart = new Date(s.getFullYear(), s.getMonth(), s.getDate() - s.getDay());
    const label = weekLabel(weekStart);
    if (label !== lastWeek) {
      listEl.appendChild(el('span', 'cal-week-label', label));
      lastWeek = label;
    }
    const isPast = s.getTime() + ev.durationMin * 60000 < now;
    const isNext = next && next.id === ev.id;
    const row = el('div', `cal-row t-${ev.tag}${isNext ? ' is-next' : ''}${isPast ? ' is-past' : ''}`);
    const date = el('div', 'cal-row__date');
    date.append(el('span', 'cal-row__dow', s.toLocaleDateString([], { weekday: 'short' })), el('span', 'cal-row__day', String(s.getDate())));
    const body = el('div', 'cal-row__body');
    if (isNext) body.appendChild(el('span', 'cal-row__next', 'NEXT UP'));
    body.appendChild(el('span', 'cal-row__title', ev.title));
    const meta = el('span', 'cal-row__meta');
    meta.append(el('i'), document.createTextNode(`${TAG_NAMES[ev.tag] || ''}${ev.category && TAG_NAMES[ev.tag] !== ev.category ? ' · ' + ev.category : ''} · ${fmtTime(s)}${viewerIsArizona ? '' : ` (${fmtAz(s)} AZ)`}`));
    body.appendChild(meta);
    row.append(date, body);
    listEl.appendChild(row);
  }

  const empty = $('cal-empty');
  empty.hidden = monthEvents.length > 0;
  if (!monthEvents.length) {
    empty.textContent = 'No streams scheduled for this month yet. Follow on Twitch to get a ping when Vince goes live!';
  }
}

function weekLabel(weekStart) {
  const thisWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
  const diff = Math.round((weekStart - thisWeek) / (7 * 86400000));
  if (diff === 0) return 'THIS WEEK';
  if (diff === 1) return 'NEXT WEEK';
  if (diff === -1) return 'LAST WEEK';
  return `WEEK OF ${weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' }).toUpperCase()}`;
}

async function load() {
  const from = new Date(state.year, state.month, 1 - 7);
  const to = new Date(state.year, state.month + 1, 8);
  try {
    const res = await fetch(`/api/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
    const data = await res.json();
    state.events = (data.events || []).sort((a, b) => a.start.localeCompare(b.start));
  } catch {
    state.events = [];
  }
  $('cal-detail').hidden = true;
  render();
}

async function loadNext() {
  try {
    const now = new Date();
    const res = await fetch(`/api/calendar?from=${encodeURIComponent(new Date(now - 6 * 3600000).toISOString())}&to=${encodeURIComponent(new Date(+now + 60 * 86400000).toISOString())}`);
    const data = await res.json();
    const next = (data.events || [])
      .filter((e) => Date.parse(e.start) + e.durationMin * 60000 > Date.now())
      .sort((a, b) => a.start.localeCompare(b.start))[0];
    state.next = next || null;
    if (next) {
      $('next-title').textContent = next.title;
      $('next-when').textContent = whenText(next);
      $('next-up').hidden = false;
    }
    render();
  } catch {}
}

$('prev-month').addEventListener('click', () => {
  state.month -= 1;
  if (state.month < 0) { state.month = 11; state.year -= 1; }
  load();
});
$('next-month').addEventListener('click', () => {
  state.month += 1;
  if (state.month > 11) { state.month = 0; state.year += 1; }
  load();
});
$('today-btn').addEventListener('click', () => {
  state.year = today.getFullYear();
  state.month = today.getMonth();
  load();
});

if (viewerIsArizona) $('tz-note').textContent = 'Times are in Arizona time (MST), where Vince streams from.';

// subscribe links
const feedHttps = `${location.origin}/api/calendar/ics`;
const feedWebcal = feedHttps.replace(/^https?:/, 'webcal:');
$('sub-webcal').href = feedWebcal;
$('sub-google').href = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(feedWebcal)}`;
$('sub-copy').addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText(feedHttps);
    e.currentTarget.textContent = 'Copied!';
  } catch {
    e.currentTarget.textContent = feedHttps;
  }
});

load();
loadNext();
