// VibesByVince — Vibesmas leaderboard (/vibesmas/leaderboard).
// Refreshes every 30 seconds. Only games Vince has published count.

(() => {
  const $ = (id) => document.getElementById(id);
  const PRIZES = ['$200', '$100', '$50'];
  const MEDAL = ['vm-m1', 'vm-m2', 'vm-m3'];
  let state = null;
  let view = 'overall';
  let loadedAt = 0;

  $('year').textContent = new Date().getFullYear();

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = String(text);
    return n;
  };

  function phaseText(s) {
    if (s.phase === 'live') return s.currentGame ? `Game ${s.currentGame} of ${s.games} in progress` : 'Tournament live';
    if (s.phase === 'review') {
      let until = '';
      if (s.reviewUntil) {
        try {
          until = ` until ${new Date(s.reviewUntil).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`;
        } catch {}
      }
      return `Results under review${until}`;
    }
    if (s.phase === 'final') return 'Final results';
    return 'Starts Saturday, December 12';
  }

  function duoCell(d) {
    const wrap = el('div', 'vm-duo');
    wrap.append(el('b', '', d.name));
    const line = el('span');
    d.players.forEach((p, i) => {
      if (i) line.append(' & ');
      if (p.twitch && p.streams) {
        const a = el('a', '', p.name);
        a.href = `https://twitch.tv/${encodeURIComponent(p.twitch)}`;
        a.target = '_blank';
        a.rel = 'noopener';
        line.append(a);
      } else {
        line.append(p.name);
      }
    });
    if (d.players.some((p) => p.live)) {
      line.append(' · ');
      line.append(el('span', 'vm-live', 'live'));
    }
    wrap.append(line);
    return wrap;
  }

  function renderTabs() {
    const tabs = $('tabs');
    tabs.textContent = '';
    const opts = [['overall', 'Overall']];
    for (let g = 1; g <= state.games; g++) opts.push([String(g), `Game ${g}`]);
    for (const [v, label] of opts) {
      const b = el('button', 'vm-tab', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(v === view));
      b.addEventListener('click', () => {
        view = v;
        render();
      });
      tabs.append(b);
    }
  }

  function render() {
    const s = state;
    renderTabs();

    const phase = $('phase');
    phase.className = `vm-phase vm-phase--${s.phase}`;
    phase.querySelector('span').textContent = phaseText(s);
    phase.hidden = false;

    const rows = s.standings || [];
    const anyScores = s.published.length > 0;

    // podium
    const pod = $('podium');
    pod.textContent = '';
    if (anyScores && rows.length) {
      rows.slice(0, 3).forEach((d, i) => {
        const li = el('li');
        const who = el('div', 'vm-podium__who');
        who.append(el('span', MEDAL[i], `${['1st', '2nd', '3rd'][i]} · ${PRIZES[i]}`), el('b', '', d.name), el('small', '', d.players.map((p) => p.name).join(' & ')));
        li.append(who, el('span', 'vm-podium__pts', d.total));
        pod.append(li);
      });
    }
    pod.hidden = !(anyScores && rows.length);

    // highlights and game-day links
    const mvp = $('mvp');
    mvp.textContent = '';
    const stat = (label, value) => {
      const div = el('div');
      div.append(el('dt', '', label), el('dd', '', value));
      mvp.append(div);
    };
    const link = (text, href) => {
      const div = el('div');
      const a = el('a', '', text);
      a.href = href;
      div.append(a);
      mvp.append(div);
    };
    if (s.mvp && s.mvp.mostKills) stat('Most kills', `${s.mvp.mostKills.name} · ${s.mvp.mostKills.kills}`);
    if (s.mvp && s.mvp.bestGame) stat('Best game', `${s.mvp.bestGame.name} · ${s.mvp.bestGame.kills} kills in game ${s.mvp.bestGame.game}`);
    if (s.phase === 'live') link('Watch the streamers live', '/vibesmas/watch');
    if (s.phase === 'final' || s.phase === 'review') link('Results page', '/vibesmas/2026');
    mvp.hidden = mvp.children.length === 0;

    // table
    const g = view === 'overall' ? 0 : Number(view);
    const head = $('thead');
    head.textContent = '';
    const cols = g ? ['#', 'Duo', 'Place', 'Kills', 'Points'] : ['#', 'Duo', ...Array.from({ length: s.games }, (_, i) => `G${i + 1}`), 'Kills', 'Total'];
    cols.forEach((c, i) => {
      const th = el('th', i >= 2 ? 'num' : '', c);
      th.scope = 'col';
      head.append(th);
    });

    let list = rows.slice();
    const gamePublished = g && s.published.includes(g);
    if (g && gamePublished) {
      list = rows
        .filter((d) => d.games[g - 1])
        .sort((a, b) => a.games[g - 1].place - b.games[g - 1].place);
    }

    const body = $('tbody');
    body.textContent = '';
    list.forEach((d, i) => {
      const tr = el('tr', (g ? gamePublished && i === 0 : anyScores && d.rank === 1) ? 'is-first' : '');
      const rank = g ? (gamePublished ? d.games[g - 1].place : '–') : anyScores ? d.rank : '–';
      const rankTd = el('td', 'rank', rank);
      const r = Number(rank);
      if (r >= 1 && r <= 3) rankTd.classList.add(MEDAL[r - 1]);
      tr.append(rankTd);
      const nameTd = el('td');
      nameTd.append(duoCell(d));
      tr.append(nameTd);
      if (g) {
        const res = d.games[g - 1];
        tr.append(el('td', 'num', res ? res.place : '–'), el('td', 'num', res ? res.kills : '–'), el('td', 'total', res ? res.pts : '–'));
      } else {
        d.games.forEach((res) => tr.append(el('td', 'num', res ? res.pts : '–')));
        tr.append(el('td', 'num', d.kills), el('td', 'total', d.total));
      }
      body.append(tr);
    });

    $('caption').textContent = g
      ? gamePublished
        ? `Game ${g} results`
        : `Game ${g} hasn't been scored yet`
      : anyScores
        ? `Overall standings after ${s.published.length} of ${s.games} games`
        : 'Approved duos. Scores appear after game 1.';

    const empty = $('empty');
    empty.hidden = list.length > 0;
    empty.textContent = g && !gamePublished ? '' : 'No duos on the roster yet.';
    if (g && !gamePublished) empty.hidden = true;
  }

  function updatedLabel() {
    if (!loadedAt) return;
    const secs = Math.round((Date.now() - loadedAt) / 1000);
    $('updated').textContent = `Updates by itself · checked ${secs < 10 ? 'just now' : `${secs}s ago`}`;
  }

  async function load() {
    try {
      const res = await fetch('/api/vibesmas', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      state = await res.json();
      loadedAt = Date.now();
      render();
      updatedLabel();
    } catch {
      if (!state) $('updated').textContent = "Couldn't load the scores. Retrying…";
    }
  }

  load();
  setInterval(() => {
    if (!document.hidden) load();
  }, 30000);
  setInterval(updatedLabel, 5000);
})();
