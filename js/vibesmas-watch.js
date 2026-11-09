// VibesByVince — Vibesmas "watch live" page (/vibesmas/watch).
// Lists every streamer from the approved duos, live ones first. The Twitch
// player is only loaded when the visitor picks a stream.

(() => {
  const $ = (id) => document.getElementById(id);
  const MAX = 4;
  let stage = []; // logins on screen, oldest first

  $('year').textContent = new Date().getFullYear();

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = String(text);
    return n;
  };

  function renderStage() {
    const grid = $('stage-grid');
    const present = new Set([...grid.children].map((n) => n.dataset.login));
    // remove players no longer on stage
    [...grid.children].forEach((n) => {
      if (!stage.includes(n.dataset.login)) n.remove();
    });
    for (const login of stage) {
      if (present.has(login)) continue;
      const wrap = el('div', 'vm-stage__item');
      wrap.dataset.login = login;
      const frame = document.createElement('iframe');
      frame.src = `https://player.twitch.tv/?channel=${encodeURIComponent(login)}&parent=${encodeURIComponent(location.hostname)}&autoplay=true&muted=${stage.length > 1}`;
      frame.title = `${login} on Twitch`;
      frame.allow = 'autoplay; fullscreen';
      frame.allowFullscreen = true;
      const close = el('button', 'vm-stage__close');
      close.type = 'button';
      close.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
      close.setAttribute('aria-label', `Stop watching ${login}`);
      close.addEventListener('click', () => {
        stage = stage.filter((l) => l !== login);
        renderStage();
      });
      wrap.append(frame, close);
      grid.append(wrap);
    }
    grid.dataset.count = String(stage.length);
    $('stage').hidden = stage.length === 0;
  }

  function watch(login) {
    if (!stage.includes(login)) {
      stage.push(login);
      if (stage.length > MAX) stage.shift();
    }
    renderStage();
    $('stage').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  $('stage-clear').addEventListener('click', () => {
    stage = [];
    renderStage();
  });

  function card(s) {
    const c = el('article', `vm-watch${s.live ? ' is-live' : ''}`);
    const media = el('div', 'vm-watch__media');
    if (s.live && s.preview) {
      const img = el('img');
      img.src = s.preview;
      img.alt = '';
      img.loading = 'lazy';
      media.append(img);
      const badge = el('span', 'vm-watch__badge', `LIVE · ${Number(s.viewers || 0).toLocaleString()}`);
      media.append(badge);
    } else {
      media.append(el('span', 'vm-watch__off', 'Offline'));
    }
    const body = el('div', 'vm-watch__body');
    const who = el('div', 'vm-watch__who');
    if (s.avatar) {
      const av = el('img', 'vm-watch__avatar');
      av.src = s.avatar;
      av.alt = '';
      av.width = 40;
      av.height = 40;
      who.append(av);
    }
    const names = el('div');
    names.append(el('b', '', s.name), el('span', '', s.duo));
    who.append(names);
    body.append(who);
    if (s.live && s.title) body.append(el('p', 'vm-watch__title', s.title));
    const row = el('div', 'vm-row');
    if (s.live) {
      const b = el('button', 'vm-btn vm-btn--small', 'Watch here');
      b.type = 'button';
      b.addEventListener('click', () => watch(s.login));
      row.append(b);
    }
    const a = el('a', s.live ? 'vm-linkbtn' : 'vm-btn vm-btn--ghost vm-btn--small', s.live ? 'Open on Twitch' : 'Twitch channel');
    a.href = `https://twitch.tv/${encodeURIComponent(s.login)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    if (s.live) a.style.textDecoration = 'underline';
    row.append(a);
    body.append(row);
    c.append(media, body);
    return c;
  }

  async function load() {
    try {
      const res = await fetch('/api/vibesmas/live', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      const list = data.streamers || [];
      const grid = $('grid');
      grid.textContent = '';
      list.forEach((s) => grid.append(card(s)));
      const live = list.filter((s) => s.live).length;
      $('live-count').textContent = list.length ? `${live} of ${list.length} streamers live` : '';
      $('empty').hidden = list.length > 0;
      $('empty').textContent = 'Streamers show up here once duos are approved.';
    } catch {
      $('live-count').textContent = "Couldn't check who's live. Retrying…";
    }
  }

  load();
  setInterval(() => {
    if (!document.hidden) load();
  }, 60000);
})();
