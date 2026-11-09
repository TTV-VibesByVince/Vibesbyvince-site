// VibesByVince — Vibesmas admin (/vibesmas/admin). Only reachable after
// signing in through Cloudflare Access; every API call is checked again on
// the server.

(() => {
  const $ = (id) => document.getElementById(id);
  const API = '/api/vibesmas/admin';
  const PTS = { 1: 10, 2: 8, 3: 6, 4: 4, 5: 2 };
  let S = null;
  let filter = 'pending';
  let game = null;

  const ERRORS = {
    not_signed_in: 'Your login expired. Reload the page to sign in again.',
    not_allowed: "This account isn't allowed to use the Vibesmas admin.",
    admin_not_configured: "The admin login isn't set up yet (ACCESS_TEAM_DOMAIN, ACCESS_AUD and ADMIN_EMAIL secrets).",
    db_not_configured: 'The database isn’t connected (D1 binding "DB").',
    bad_origin: 'That request was blocked. Reload the page and try again.',
    full: 'All 40 spots are taken. Remove or decline a duo first.',
    duplicate_placement: 'Two duos have the same placement. Fix it before saving.',
    bad_placement: 'Placements must be whole numbers from 1 to 100.',
    bad_kills: 'Kills must be whole numbers from 0 to 99.',
  };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = String(text);
    return n;
  };

  async function api(path, body) {
    const res = await fetch(`${API}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) throw new Error(ERRORS[data && data.error] || (data && data.message) || `Error ${res.status}`);
    return data;
  }

  let flashTimer;
  function flash(text) {
    $('error').hidden = true;
    $('flash').textContent = text;
    $('flash').hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => ($('flash').hidden = true), 4000);
  }
  function fail(err) {
    $('flash').hidden = true;
    $('error').textContent = err.message;
    $('error').hidden = false;
  }

  function when(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch {
      return iso;
    }
  }

  // ---------- tabs ----------

  document.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      ['approvals', 'scores', 'results'].forEach((t) => ($(`pane-${t}`).hidden = t !== b.dataset.tab));
    }),
  );
  document.querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((x) => {
        x.setAttribute('aria-pressed', String(x === b));
        x.setAttribute('aria-selected', String(x === b));
      });
      renderDuos();
    }),
  );
  document.querySelector('[data-filter="pending"]').setAttribute('aria-selected', 'true');

  // ---------- approvals ----------

  const BADGE = { pending: ['Waiting', 'vm-badge--pending'], approved: ['Approved', 'vm-badge--approved'], declined: ['Declined', 'vm-badge--declined'] };

  function playersTable(d) {
    const wrap = el('div');
    wrap.style.overflowX = 'auto';
    const t = el('table', 'vm-mini');
    const head = el('tr');
    ['Player', 'Epic', 'Twitch', 'Discord', ''].forEach((h) => head.append(el('th', '', h)));
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    [1, 2].forEach((n) => {
      const p = d[`p${n}`];
      const tr = el('tr');
      tr.append(el('td', '', `Player ${n}`), el('td', '', p.epic));
      const tw = el('td');
      if (p.twitch) {
        const a = el('a', '', p.twitch);
        a.href = `https://twitch.tv/${encodeURIComponent(p.twitch)}`;
        a.target = '_blank';
        a.rel = 'noopener';
        tw.append(a);
      } else tw.append(el('span', 'vm-small', 'none'));
      const dc = el('td');
      dc.append(p.discord ? p.discord : el('span', 'vm-small', 'none'));
      const streams = d.streams === 'both' || d.streams === `p${n}`;
      const tags = [];
      if (streams) tags.push('streams');
      const contact = p.discord && (n === 1 || !d.p1.discord);
      if (contact) tags.push('Discord contact');
      tr.append(tw, dc, el('td', 'vm-ok', tags.join(' · ')));
      tbody.append(tr);
    });
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }

  function act(d, action, note) {
    return async () => {
      try {
        await api('duo', { id: d.id, action, note });
        flash(
          { approve: `${d.name} approved.`, decline: `${d.name} declined.`, pending: `${d.name} moved back to waiting.`, delete: `${d.name} removed.` }[action],
        );
        await load();
      } catch (err) {
        fail(err);
      }
    };
  }

  function duoCard(d) {
    const card = el('article', `vm-card${d.status === 'pending' ? ' vm-card--waiting' : ''}`);
    const head = el('div', 'vm-card__head');
    const left = el('div');
    left.append(el('b', '', d.name), el('small', '', `Signed up ${when(d.createdAt)}${d.updatedAt !== d.createdAt ? ` · edited ${when(d.updatedAt)}` : ''}`));
    const [label, cls] = BADGE[d.status] || BADGE.pending;
    head.append(left, el('span', `vm-badge ${cls}`, label));
    card.append(head, playersTable(d));
    if (d.note) card.append(el('p', 'vm-small', `Note: ${d.note}`));

    const row = el('div', 'vm-row');
    if (d.status !== 'approved') {
      const ok = el('button', 'vm-btn vm-btn--small', 'Approve');
      ok.type = 'button';
      const no = el('button', 'vm-btn vm-btn--danger vm-btn--small', d.status === 'declined' ? 'Update note' : 'Decline');
      no.type = 'button';
      const note = el('input', 'vm-input');
      note.placeholder = 'Optional note, shown on their status page';
      note.maxLength = 300;
      note.setAttribute('aria-label', `Note to ${d.name}`);
      note.value = d.note || '';
      ok.addEventListener('click', () => act(d, 'approve', note.value)());
      no.addEventListener('click', () => act(d, 'decline', note.value)());
      row.append(ok, no, note);
    } else {
      const back = el('button', 'vm-linkbtn', 'Move back to waiting');
      back.type = 'button';
      back.addEventListener('click', act(d, 'pending'));
      row.append(back);
    }
    const del = el('button', 'vm-linkbtn', 'Remove');
    del.type = 'button';
    del.addEventListener('click', () => {
      del.hidden = true;
      const confirmRow = el('span', 'vm-row');
      const yes = el('button', 'vm-btn vm-btn--danger vm-btn--small', `Yes, remove ${d.name}`);
      yes.type = 'button';
      yes.addEventListener('click', act(d, 'delete'));
      const keep = el('button', 'vm-linkbtn', 'Keep');
      keep.type = 'button';
      keep.addEventListener('click', () => {
        confirmRow.remove();
        del.hidden = false;
      });
      confirmRow.append(el('span', 'vm-small', 'Removes the duo and its scores.'), yes, keep);
      row.append(confirmRow);
    });
    row.append(del);
    card.append(row);
    return card;
  }

  function renderDuos() {
    const list = $('duo-list');
    list.textContent = '';
    const shown = S.duos.filter((d) => filter === 'all' || d.status === filter);
    shown.forEach((d) => list.append(duoCard(d)));
    const empty = $('duo-empty');
    empty.hidden = shown.length > 0;
    empty.textContent = { pending: 'Nobody is waiting. All caught up.', approved: 'No approved duos yet.', declined: 'No declined duos.', all: 'No sign-ups yet.' }[filter];

    const n = (s) => S.duos.filter((d) => d.status === s).length;
    $('counts').textContent = `${n('pending')} waiting · ${n('approved')} of ${S.maxDuos} approved · ${S.regOpen ? 'sign-ups close Dec 5, 11:59 PM MST' : 'sign-ups closed'}`;
    $('tab-approvals').textContent = n('pending') ? `Approvals (${n('pending')})` : 'Approvals';
  }

  // ---------- scores ----------

  function gameInfo(g) {
    return S.games.find((x) => x.game === g);
  }

  function renderGameSelect() {
    const sel = $('game');
    sel.textContent = '';
    for (let g = 1; g <= S.games_total; g++) {
      const info = gameInfo(g);
      const o = el('option', '', `Game ${g}${info ? (info.published ? ' · published' : ' · draft') : ''}`);
      o.value = String(g);
      sel.append(o);
    }
    if (!game) {
      const firstOpen = [...Array(S.games_total).keys()].map((i) => i + 1).find((g) => !(gameInfo(g) && gameInfo(g).published));
      game = S.currentGame || firstOpen || 1;
    }
    sel.value = String(game);
  }
  $('game').addEventListener('change', () => {
    game = Number($('game').value);
    renderScores();
  });

  function checkScores() {
    const places = new Map();
    let dupes = false;
    $('score-rows').querySelectorAll('tr').forEach((tr) => {
      const p = tr.querySelector('[data-k="placement"]');
      const k = tr.querySelector('[data-k="kills"]');
      const pv = p.value === '' ? null : Number(p.value);
      const kv = k.value === '' ? 0 : Number(k.value);
      tr.querySelector('.total').textContent = pv ? (PTS[pv] || 0) + kv : '–';
      p.removeAttribute('aria-invalid');
      if (pv) {
        if (places.has(pv)) {
          dupes = true;
          p.setAttribute('aria-invalid', 'true');
          places.get(pv).setAttribute('aria-invalid', 'true');
        } else places.set(pv, p);
      }
    });
    $('score-warn').textContent = dupes ? 'Two duos have the same placement. Fix it before saving.' : '';
    return !dupes;
  }

  function renderScores() {
    const body = $('score-rows');
    body.textContent = '';
    const approved = S.duos.filter((d) => d.status === 'approved');
    const saved = new Map(S.scores.filter((s) => s.game === game).map((s) => [s.duo_id, s]));
    approved.forEach((d) => {
      const tr = el('tr');
      tr.dataset.id = d.id;
      const th = el('th', '', d.name);
      th.scope = 'row';
      th.style.padding = '10px 8px 10px 20px';
      const s = saved.get(d.id);
      const mk = (k, val, max) => {
        const td = el('td');
        const i = el('input', 'vm-num');
        i.type = 'number';
        i.min = k === 'placement' ? '1' : '0';
        i.max = String(max);
        i.inputMode = 'numeric';
        i.dataset.k = k;
        i.value = val === undefined || val === null ? '' : String(val);
        i.setAttribute('aria-label', `${d.name} ${k === 'placement' ? 'placement' : 'kills'}`);
        i.addEventListener('input', checkScores);
        td.append(i);
        return td;
      };
      tr.append(th, mk('placement', s && s.placement, 100), mk('kills', s ? s.kills : '', 99), el('td', 'total', '–'));
      body.append(tr);
    });
    if (!approved.length) {
      const tr = el('tr');
      const td = el('td', '', 'Approve some duos first.');
      td.colSpan = 4;
      td.style.padding = '18px 20px';
      tr.append(td);
      body.append(tr);
    }
    const info = gameInfo(game);
    $('game-state').textContent = info ? (info.published ? `Published · last saved ${when(info.updated_at)}` : `Draft · last saved ${when(info.updated_at)}`) : 'Not scored yet';
    $('publish').textContent = info && info.published ? `Update game ${game}` : `Publish game ${game}`;
    $('unpublish').hidden = !(info && info.published);
    // once a game is public, saving always updates the public scores
    $('save-draft').hidden = !!(info && info.published);
    checkScores();
  }

  function readScores() {
    return [...$('score-rows').querySelectorAll('tr[data-id]')].map((tr) => ({
      id: Number(tr.dataset.id),
      placement: tr.querySelector('[data-k="placement"]').value,
      kills: tr.querySelector('[data-k="kills"]').value || 0,
    }));
  }

  async function saveScores(publish) {
    if (!checkScores()) return;
    try {
      await api('scores', { game, rows: readScores(), publish });
      flash(publish === true ? `Game ${game} is live on the leaderboard.` : publish === false ? `Game ${game} is hidden from the leaderboard.` : `Game ${game} draft saved.`);
      await load();
    } catch (err) {
      fail(err);
    }
  }
  $('publish').addEventListener('click', () => saveScores(true));
  $('save-draft').addEventListener('click', () => saveScores(undefined));
  $('unpublish').addEventListener('click', () => saveScores(false));

  // ---------- results ----------

  async function setting(body, msg) {
    try {
      await api('settings', body);
      flash(msg);
      await load();
    } catch (err) {
      fail(err);
    }
  }

  document.querySelectorAll('[data-phase]').forEach((b) =>
    b.addEventListener('click', () => {
      const labels = { signups: 'Status: before the tournament.', live: 'Status: live.', review: 'The 24-hour review window has started.', final: 'Results are marked final.' };
      setting({ phase: b.dataset.phase }, labels[b.dataset.phase]);
    }),
  );
  $('current-game').addEventListener('change', () => {
    const v = $('current-game').value;
    setting({ currentGame: v ? Number(v) : null }, v ? `Game ${v} marked as in progress.` : 'No game in progress.');
  });
  $('outfit-save').addEventListener('click', () => setting({ outfitWinner: $('outfit').value }, $('outfit').value ? 'Outfit winner saved.' : 'Outfit winner cleared.'));

  function renderResults() {
    document.querySelectorAll('[data-phase]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.phase === S.phase)));
    const sel = $('current-game');
    sel.textContent = '';
    const none = el('option', '', 'None');
    none.value = '';
    sel.append(none);
    for (let g = 1; g <= S.games_total; g++) {
      const o = el('option', '', `Game ${g}`);
      o.value = String(g);
      sel.append(o);
    }
    sel.value = S.currentGame ? String(S.currentGame) : '';
    if (document.activeElement !== $('outfit')) $('outfit').value = S.outfitWinner || '';
  }

  function renderLog() {
    const ol = $('log');
    ol.textContent = '';
    S.log.forEach((l) => {
      const li = el('li');
      li.append(el('span', '', `${l.actor === 'sign-up' ? '' : `${l.actor} `}${l.text}`), el('small', '', when(l.at)));
      ol.append(li);
    });
    if (!S.log.length) ol.append(el('li', 'vm-small', 'Nothing yet.'));
  }

  // ---------- load ----------

  async function load() {
    try {
      const data = await api('state');
      // "games" is the list of scored games; "gameCount" is how many there are in total
      S = { ...data, games: Array.isArray(data.games) ? data.games : [], games_total: data.gameCount || 5 };
      $('signed-in').textContent = data.signedIn === 'local-dev' ? 'Local test mode' : `Signed in as ${data.signedIn}`;
      renderDuos();
      renderGameSelect();
      renderScores();
      renderResults();
      renderLog();
    } catch (err) {
      fail(err);
    }
  }

  load();
})();
