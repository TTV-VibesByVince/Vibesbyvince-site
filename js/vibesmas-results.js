// VibesByVince — Vibesmas 2026 hall of fame (/vibesmas/2026).
// Shows the champions, highlights and final standings once Vince marks the
// results final (or as provisional during the 24-hour review).

(() => {
  const $ = (id) => document.getElementById(id);
  const PRIZES = ['$200', '$100', '$50'];
  $('year').textContent = new Date().getFullYear();

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = String(text);
    return n;
  };
  const players = (d) => d.players.map((p) => p.name).join(' & ');

  async function load() {
    let s;
    try {
      const res = await fetch('/api/vibesmas');
      if (!res.ok) throw new Error(res.status);
      s = await res.json();
    } catch {
      $('waiting').hidden = false;
      $('waiting-text').textContent = "Couldn't load the results. Try again in a minute.";
      return;
    }

    const done = s.phase === 'final' || s.phase === 'review';
    if (!done || !s.standings.length || !s.published.length) {
      $('waiting').hidden = false;
      if (s.phase === 'live') $('waiting-title').textContent = 'The tournament is on right now';
      return;
    }

    $('results').hidden = false;
    if (s.phase === 'review') {
      $('provisional').hidden = false;
      $('provisional').textContent = 'Provisional: results are in the 24-hour review window and may still change.';
    }

    const [first, ...rest] = s.standings;
    const champ = $('champ');
    const left = el('div', 'vm-champ__who');
    left.append(el('span', 'vm-m1', `1st place · ${PRIZES[0]}`), el('b', '', first.name), el('span', 'vm-champ__players', players(first)));
    const right = el('div', 'vm-champ__pts');
    right.append(el('b', '', first.total), el('span', '', `points · ${first.kills} kills`));
    champ.append(left, right);

    const runners = $('runners');
    rest.slice(0, 2).forEach((d, i) => {
      const li = el('li');
      const who = el('div', 'vm-podium__who');
      who.append(el('span', i ? 'vm-m3' : 'vm-m2', `${i ? '3rd' : '2nd'} · ${PRIZES[i + 1]}`), el('b', '', d.name), el('small', '', players(d)));
      li.append(who, el('span', 'vm-podium__pts', d.total));
      runners.append(li);
    });

    const mvp = $('mvp');
    const stat = (label, value) => {
      const div = el('div');
      div.append(el('dt', '', label), el('dd', '', value));
      mvp.append(div);
    };
    if (s.mvp && s.mvp.mostKills) stat('Most kills overall', `${s.mvp.mostKills.name} · ${s.mvp.mostKills.kills} kills`);
    if (s.mvp && s.mvp.bestGame) stat('Best single game', `${s.mvp.bestGame.name} · ${s.mvp.bestGame.kills} kills in game ${s.mvp.bestGame.game}`);
    stat('Duos', `${s.standings.length} duos · ${s.published.length} games`);

    if (s.outfitWinner) $('sweater').textContent = s.outfitWinner;

    const body = $('tbody');
    s.standings.forEach((d) => {
      const tr = el('tr', d.rank === 1 ? 'is-first' : '');
      const rank = el('td', 'rank', d.rank);
      if (d.rank <= 3) rank.classList.add(['vm-m1', 'vm-m2', 'vm-m3'][d.rank - 1]);
      const name = el('td');
      const wrap = el('div', 'vm-duo');
      wrap.append(el('b', '', d.name), el('span', '', players(d)));
      name.append(wrap);
      tr.append(rank, name, el('td', 'num', d.kills), el('td', 'total', d.total));
      body.append(tr);
    });
  }

  load();
})();
