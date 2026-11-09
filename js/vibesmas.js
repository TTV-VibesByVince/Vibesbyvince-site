// VibesByVince — Vibesmas Tournament info page (/vibesmas).
// Fills in the visitor's local start time, the countdown, how many duos
// are approved, the roster and the outfit winner.

(() => {
  const $ = (id) => document.getElementById(id);
  const START = Date.parse('2026-12-12T17:00:00Z');

  $('year').textContent = new Date().getFullYear();

  // Respect "reduce motion": show the still poster instead of the loop.
  const video = $('logo-video');
  if (video && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    video.removeAttribute('autoplay');
    video.pause();
  }

  function localLine() {
    const left = START - Date.now();
    let when = '';
    try {
      when = new Date(START).toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      });
    } catch {
      return;
    }
    const el = $('local-time');
    el.textContent = '';
    el.append('Your time: ');
    const b = document.createElement('b');
    b.textContent = when;
    el.append(b);
    if (left > 0) {
      const days = Math.floor(left / 86400000);
      const hours = Math.floor((left % 86400000) / 3600000);
      const mins = Math.floor((left % 3600000) / 60000);
      el.append(` · starts in ${days ? `${days} day${days === 1 ? '' : 's'}, ` : ''}${hours} hr${hours === 1 ? '' : 's'}${days ? '' : `, ${mins} min`}`);
    }
    el.hidden = false;
  }
  localLine();
  setInterval(localLine, 60000);

  function playerText(p) {
    return p.name;
  }

  async function load() {
    let s;
    try {
      const res = await fetch('/api/vibesmas');
      if (!res.ok) throw new Error(res.status);
      s = await res.json();
    } catch {
      $('reg-count').textContent = '';
      return;
    }

    const n = s.approved || 0;
    $('reg-count').textContent = `${n} / ${s.maxDuos} duos`;
    $('reg-bar').setAttribute('aria-valuenow', String(n));
    $('reg-fill').style.width = `${Math.min(100, (n / s.maxDuos) * 100)}%`;

    if (!s.regOpen) {
      const full = n >= s.maxDuos;
      $('reg-text').textContent = full
        ? 'All 40 spots are filled. Thanks for the love! Watch the tournament live on December 12.'
        : 'Registration is closed. Watch the tournament live on Saturday, December 12.';
      const cta = $('signup-cta');
      cta.textContent = 'See the leaderboard';
      cta.href = '/vibesmas/leaderboard';
    }

    if (s.phase === 'live') {
      const cta = $('signup-cta');
      cta.textContent = 'Watch live';
      cta.href = '/vibesmas/watch';
    } else if (s.phase === 'final' || s.phase === 'review') {
      const cta = $('signup-cta');
      cta.textContent = s.phase === 'final' ? 'See the results' : 'Results (under review)';
      cta.href = s.phase === 'final' ? '/vibesmas/2026' : '/vibesmas/leaderboard';
    }

    if (s.outfitWinner) {
      const p = $('outfit-text');
      p.textContent = 'Winner: ';
      const b = document.createElement('span');
      b.className = 'vm-winner';
      b.textContent = s.outfitWinner;
      p.append(b);
    }

    const list = $('roster');
    list.textContent = '';
    const duos = (s.standings || []).slice().sort((a, b) => a.id - b.id);
    for (const d of duos) {
      const li = document.createElement('li');
      const name = document.createElement('b');
      name.textContent = d.name;
      const who = document.createElement('span');
      who.textContent = d.players.map(playerText).join(' & ');
      li.append(name, who);
      list.append(li);
    }
    $('roster-empty').hidden = duos.length > 0;
    $('duos-count').textContent = duos.length ? `${duos.length} of ${s.maxDuos}` : '';
  }

  load();
})();
