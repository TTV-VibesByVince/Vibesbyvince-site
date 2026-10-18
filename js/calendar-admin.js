// VibesByVince — schedule admin (/calendar/admin). Only reachable after
// signing in through Cloudflare Access; every API call is checked again
// on the server.

const $ = (id) => document.getElementById(id);
const API = '/api/calendar/admin';
const TAG_NAMES = { fortnite: 'Fortnite', horror: 'Horror', variety: 'Variety', special: 'Special' };

const ERRORS = {
  title_required: 'Give the stream a title.',
  title_too_long: 'Titles can be at most 140 characters (Twitch limit).',
  bad_date: 'Pick a date and a start time.',
  bad_duration: 'Streams must be between 30 minutes and 23 hours (Twitch limit).',
  not_signed_in: 'Your login expired. Reload the page to sign in again.',
  not_allowed: "This account isn't allowed to edit the schedule.",
  admin_not_configured: 'The admin login isn’t set up yet (ACCESS_TEAM_DOMAIN, ACCESS_AUD and ADMIN_EMAIL secrets).',
  db_not_configured: 'The calendar database isn’t connected yet (D1 binding "DB").',
  bad_origin: 'That request was blocked. Reload the page and try again.',
};

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}/${path}`, {
    ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
    credentials: 'same-origin',
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const code = data && data.error;
    throw new Error(ERRORS[code] || (data && data.message) || code || `Error ${res.status}`);
  }
  return data;
}

function flash(text, kind = 'ok') {
  $('flash-text').textContent = text;
  $('flash').className = `notice${kind === 'warn' ? ' notice--warn' : ''}`;
  $('flash').hidden = false;
}
$('flash-close').addEventListener('click', () => ($('flash').hidden = true));

// ---- Arizona time helpers (always UTC-7) ----
const AZ_MS = 7 * 3600000;
function toAzParts(iso) {
  const d = new Date(Date.parse(iso) - AZ_MS);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}
function azLabel(iso) {
  const d = new Date(iso);
  const opts = { timeZone: 'America/Phoenix' };
  return {
    dow: d.toLocaleDateString('en-US', { ...opts, weekday: 'short' }).toUpperCase(),
    day: d.toLocaleDateString('en-US', { ...opts, month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString('en-US', { ...opts, hour: 'numeric', minute: '2-digit' }),
  };
}
function lenLabel(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h ? h + 'h' : ''}${m ? ` ${m}m` : ''}`.trim();
}

// ---- status / Twitch ----
let twitchConnected = false;

async function loadStatus() {
  try {
    const s = await api('status');
    $('admin-error').hidden = true;
    $('signed-in').textContent = s.email && s.email !== 'local-dev' ? `signed in as ${s.email}` : '';
    const tw = s.twitch || {};
    twitchConnected = !!tw.connected;
    const pill = $('twitch-pill');
    if (!tw.configured) {
      pill.textContent = 'Twitch: app keys not set up';
      pill.className = 'pill pill--warn';
    } else if (tw.connected) {
      pill.textContent = `Twitch connected · ${tw.login}`;
      pill.className = 'pill';
      if (tw.broadcasterType !== 'affiliate' && tw.broadcasterType !== 'partner') {
        flash('Heads up: Twitch only lets Affiliates and Partners add one-off schedule entries, so syncing may be refused for this channel.', 'warn');
      }
    } else {
      pill.textContent = 'Twitch: not connected';
      pill.className = 'pill pill--warn';
    }
    $('twitch-connect').hidden = !tw.configured || tw.connected;
    $('twitch-disconnect').hidden = !tw.connected;
    $('import-box').hidden = !!s.importedAt;
    $('save-hint').textContent = tw.connected ? 'Saves here and on your Twitch schedule.' : 'Saves here (connect Twitch to sync).';
  } catch (err) {
    $('admin-error').textContent = err.message;
    $('admin-error').hidden = false;
  }
}

$('twitch-disconnect').addEventListener('click', async () => {
  if (!confirm('Disconnect Twitch? Streams stay here, but changes stop syncing to Twitch until you connect again.')) return;
  try {
    await api('twitch/disconnect', { method: 'POST' });
    await loadStatus();
    await loadEvents();
  } catch (err) {
    flash(err.message, 'warn');
  }
});

// result of the Twitch connect redirect (?twitch=connected etc.)
(() => {
  const p = new URLSearchParams(location.search).get('twitch');
  if (!p) return;
  const msgs = {
    connected: 'Twitch connected! New and changed streams now sync to your Twitch schedule.',
    cancelled: 'Twitch connection cancelled.',
    expired: 'That Twitch sign-in took too long. Try Connect Twitch again.',
    failed: "Couldn't connect Twitch. Try again.",
  };
  flash(msgs[p] || msgs.failed, p === 'connected' ? 'ok' : 'warn');
  history.replaceState(null, '', location.pathname);
})();

$('import-btn').addEventListener('click', async (e) => {
  if (!twitchConnected && !confirm("Twitch isn't connected, so only Google Calendar streams will be imported. Continue?")) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const r = await api('import', { method: 'POST' });
    let msg = `Import done: ${r.fromTwitch} from Twitch, ${r.fromGoogle} from Google Calendar.`;
    if (r.replacedRecurring) msg += ` ${r.replacedRecurring} repeating Twitch ${r.replacedRecurring === 1 ? 'series was' : 'series were'} split into individual weeks.`;
    if (r.notes && r.notes.length) msg += ' ' + r.notes.join(' ');
    flash(msg, r.notes && r.notes.length ? 'warn' : 'ok');
    await loadStatus();
    await loadEvents();
  } catch (err) {
    flash(err.message, 'warn');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import now';
  }
});

// ---- event list ----
let when = 'upcoming';
let events = [];

document.querySelectorAll('[data-when]').forEach((b) =>
  b.addEventListener('click', () => {
    when = b.dataset.when;
    document.querySelectorAll('[data-when]').forEach((x) => x.classList.toggle('is-on', x === b));
    $('list-h').textContent = when === 'past' ? 'Past' : 'Upcoming';
    loadEvents();
  })
);

function twitchBadge(ev) {
  if (ev.twitchStatus === 'ok') return el('span', 'tw-ok', '✓ on Twitch');
  if (ev.twitchStatus === 'error') return el('span', 'tw-bad', `⚠ Twitch didn't update: ${ev.twitchError || 'unknown error'}`);
  if (ev.twitchStatus === 'off') return el('span', 'tw-off', 'not on Twitch (not connected)');
  if (ev.twitchStatus === 'pending') return el('span', 'tw-off', 'waiting to sync');
  return null; // past
}

function renderEvents() {
  const list = $('event-list');
  list.textContent = '';
  if (!events.length) {
    list.appendChild(el('p', 'hint', when === 'past' ? 'No past streams yet.' : 'Nothing scheduled yet. Add a stream on the left.'));
    return;
  }
  for (const ev of events) {
    const a = azLabel(ev.start);
    const row = el('div', `adm-item t-${ev.tag}`);
    const date = el('div', 'adm-item__date');
    date.append(el('span', 'adm-item__dow', a.dow), el('span', 'adm-item__day', a.day), el('span', 'adm-item__time', a.time));

    const body = el('div');
    body.style.minWidth = '0';
    body.appendChild(el('div', 'adm-item__title', ev.title));
    const meta = el('div', 'adm-item__meta');
    meta.append(el('i'), document.createTextNode(`${ev.categoryName || TAG_NAMES[ev.tag]} · ${lenLabel(ev.durationMin)}`));
    const badge = twitchBadge(ev);
    if (badge) meta.appendChild(badge);
    body.appendChild(meta);

    const actions = el('div', 'adm-item__actions');
    if (ev.twitchStatus === 'error' || ev.twitchStatus === 'pending' || (ev.twitchStatus === 'off' && twitchConnected)) {
      const retry = el('button', 'small-btn', ev.twitchStatus === 'error' ? 'Retry' : 'Sync');
      retry.type = 'button';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try {
          await api(`events/${ev.id}/sync`, { method: 'POST' });
          await loadEvents();
        } catch (err) {
          flash(err.message, 'warn');
          retry.disabled = false;
        }
      });
      actions.appendChild(retry);
    }
    if (when === 'upcoming') {
      const edit = el('button', 'small-btn', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', () => startEdit(ev));
      actions.appendChild(edit);
    }
    const del = el('button', 'small-btn small-btn--danger', 'Delete');
    del.type = 'button';
    del.setAttribute('aria-label', `Delete ${ev.title} on ${a.day}`);
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${ev.title}" on ${a.day}? It's removed from Twitch too.`)) return;
      del.disabled = true;
      try {
        await api(`events/${ev.id}`, { method: 'DELETE' });
        await loadEvents();
      } catch (err) {
        flash(err.message, 'warn');
        del.disabled = false;
      }
    });
    actions.appendChild(del);

    row.append(date, body, actions);
    list.appendChild(row);
  }
}

async function loadEvents() {
  try {
    const r = await api(`events?when=${when}`);
    events = r.events || [];
    renderEvents();
  } catch (err) {
    $('event-list').textContent = '';
    $('event-list').appendChild(el('p', 'form-msg is-error', err.message));
  }
}

// ---- form ----
const form = $('event-form');

function resetForm() {
  form.reset();
  $('f-id').value = '';
  $('f-cat-id').value = '';
  $('f-len').value = '180';
  $('repeat-wrap').hidden = false;
  $('repeat-weeks').hidden = true;
  $('form-h').textContent = 'Add a stream';
  $('f-save').textContent = 'Save stream';
  $('f-cancel').hidden = true;
  // default: next Arizona date at 7 PM
  const az = new Date(Date.now() - AZ_MS + 86400000);
  $('f-date').value = az.toISOString().slice(0, 10);
  $('f-time').value = '19:00';
}

function startEdit(ev) {
  const p = toAzParts(ev.start);
  $('f-id').value = ev.id;
  $('f-title').value = ev.title;
  $('f-cat').value = ev.categoryName || '';
  $('f-cat-id').value = ev.categoryId || '';
  $('f-date').value = p.date;
  $('f-time').value = p.time;
  if (![...$('f-len').options].some((o) => +o.value === ev.durationMin)) {
    $('f-len').appendChild(new Option(lenLabel(ev.durationMin), ev.durationMin));
  }
  $('f-len').value = String(ev.durationMin);
  $('f-tag').value = ev.tag;
  $('repeat-wrap').hidden = true;
  $('form-h').textContent = 'Edit stream';
  $('f-save').textContent = 'Save changes';
  $('f-cancel').hidden = false;
  $('form-msg').textContent = '';
  $('f-title').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('f-cancel').addEventListener('click', resetForm);
$('f-repeat').addEventListener('change', (e) => ($('repeat-weeks').hidden = !e.target.checked));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('form-msg');
  msg.className = 'form-msg';
  msg.textContent = 'Saving…';
  $('f-save').disabled = true;

  // if the category box was typed in but nothing picked, don't send a stale id
  const catName = $('f-cat').value.trim();
  const body = {
    title: $('f-title').value.trim(),
    categoryId: catName ? $('f-cat-id').value || null : null,
    categoryName: catName || null,
    date: $('f-date').value,
    time: $('f-time').value,
    durationMin: parseInt($('f-len').value, 10),
    tag: $('f-tag').value || null,
    repeatWeeks: !$('f-id').value && $('f-repeat').checked ? parseInt($('f-weeks').value, 10) || 1 : 1,
  };

  try {
    const id = $('f-id').value;
    const r = id
      ? await api(`events/${id}`, { method: 'PUT', body: JSON.stringify(body) })
      : await api('events', { method: 'POST', body: JSON.stringify(body) });
    const saved = r.events || [r.event];
    const failed = saved.filter((x) => x.twitchStatus === 'error').length;
    msg.className = `form-msg ${failed ? 'is-error' : 'is-ok'}`;
    msg.textContent = failed
      ? `Saved, but ${failed} ${failed === 1 ? "didn't" : "didn't all"} reach Twitch. See the list for details.`
      : `Saved${saved.length > 1 ? ` ${saved.length} weeks` : ''}${twitchConnected ? ' and synced to Twitch' : ''}.`;
    resetForm();
    when = 'upcoming';
    document.querySelectorAll('[data-when]').forEach((x) => x.classList.toggle('is-on', x.dataset.when === 'upcoming'));
    $('list-h').textContent = 'Upcoming';
    await loadEvents();
  } catch (err) {
    msg.className = 'form-msg is-error';
    msg.textContent = err.message;
  } finally {
    $('f-save').disabled = false;
  }
});

// ---- Twitch category search (combobox) ----
const catInput = $('f-cat');
const catList = $('cat-list');
let catTimer = null;
let catOpts = [];
let catActive = -1;

function closeCats() {
  catList.hidden = true;
  catInput.setAttribute('aria-expanded', 'false');
  catActive = -1;
}

function pickCat(c) {
  catInput.value = c.name;
  $('f-cat-id').value = c.id;
  closeCats();
}

function renderCats() {
  catList.textContent = '';
  catOpts.forEach((c, i) => {
    const li = el('li', 'combo__opt');
    li.id = `cat-opt-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', i === catActive ? 'true' : 'false');
    if (c.art) {
      const img = el('img');
      img.src = c.art;
      img.alt = '';
      li.appendChild(img);
    }
    li.appendChild(document.createTextNode(c.name));
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickCat(c);
    });
    catList.appendChild(li);
  });
  catList.hidden = catOpts.length === 0;
  catInput.setAttribute('aria-expanded', catOpts.length ? 'true' : 'false');
  catInput.setAttribute('aria-activedescendant', catActive >= 0 ? `cat-opt-${catActive}` : '');
}

catInput.addEventListener('input', () => {
  $('f-cat-id').value = '';
  clearTimeout(catTimer);
  const q = catInput.value.trim();
  if (q.length < 2) {
    catOpts = [];
    renderCats();
    return;
  }
  catTimer = setTimeout(async () => {
    try {
      const r = await api(`categories?q=${encodeURIComponent(q)}`);
      catOpts = r.categories || [];
      catActive = -1;
      renderCats();
    } catch {
      catOpts = [];
      renderCats();
    }
  }, 250);
});

catInput.addEventListener('keydown', (e) => {
  if (catList.hidden) return;
  if (e.key === 'ArrowDown') { catActive = Math.min(catOpts.length - 1, catActive + 1); renderCats(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { catActive = Math.max(0, catActive - 1); renderCats(); e.preventDefault(); }
  else if (e.key === 'Enter' && catActive >= 0) { pickCat(catOpts[catActive]); e.preventDefault(); }
  else if (e.key === 'Escape') closeCats();
});
catInput.addEventListener('blur', () => setTimeout(closeCats, 100));

resetForm();
loadStatus().then(loadEvents);
