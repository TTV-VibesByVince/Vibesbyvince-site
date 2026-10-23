// VibesByVince — the secret.
//
// Type "vibes" or "matrix" anywhere on the site (not while typing in a box),
// or tap the logo / page title 5 times quickly on a phone. The site plays
// the VibesByVince code-rain video full screen with sound, then offers
// Matrix mode: a green-on-black version of the site with falling code,
// kept for the rest of the visit (sessionStorage) until you exit it.
//
// Esc or the Skip button stops the video at any time. Visitors who ask
// their device for less motion get a "Play the secret video?" prompt
// instead of an instant takeover, and the code rain doesn't move for them.

(() => {
  const WORDS = ['vibes', 'matrix'];
  const VIDEO = '/assets/video/vibes-matrix.mp4';
  const POSTER = '/assets/video/vibes-matrix-poster.jpg';
  const STORE_KEY = 'vbv-matrix-mode';
  const TAPS_NEEDED = 5;
  const TAP_WINDOW_MS = 2000;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let overlay = null;
  let lastFocus = null;

  // ---------- triggers ----------

  let typed = '';
  document.addEventListener('keydown', (e) => {
    if (overlay) {
      if (e.key === 'Escape') skipVideo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!e.key || e.key.length !== 1) return;
    typed = (typed + e.key.toLowerCase()).slice(-12);
    if (WORDS.some((w) => typed.endsWith(w))) {
      typed = '';
      start();
    }
  });

  let taps = [];
  document.addEventListener('click', (e) => {
    const target = e.target.closest && e.target.closest('[data-egg-tap]');
    if (!target || overlay) return;
    const now = Date.now();
    taps = taps.filter((t) => now - t < TAP_WINDOW_MS);
    taps.push(now);
    if (taps.length >= TAPS_NEEDED) {
      taps = [];
      start();
    }
  });

  // ---------- the takeover ----------

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function button(cls, text, onClick) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function start() {
    if (overlay) return;
    lastFocus = document.activeElement;
    overlay = el('div', 'egg');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Secret video');
    document.body.appendChild(overlay);
    document.documentElement.classList.add('egg-open');
    if (reduceMotion) askFirst();
    else playVideo();
  }

  function askFirst() {
    overlay.textContent = '';
    const card = el('div', 'egg__card');
    card.append(
      el('p', 'egg__kicker', '> secret found_'),
      el('h2', 'egg__title', 'Play the secret video?'),
      el('p', 'egg__text', 'It has sound and fast-moving code rain.')
    );
    const row = el('div', 'egg__row');
    row.append(button('egg__btn egg__btn--primary', 'Play it', playVideo), button('egg__btn', 'No thanks', close));
    card.appendChild(row);
    overlay.appendChild(card);
    row.firstChild.focus();
  }

  function playVideo() {
    overlay.textContent = '';
    const video = el('video', 'egg__video');
    video.src = VIDEO;
    video.poster = POSTER;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.addEventListener('ended', showEndCard);
    video.addEventListener('error', showEndCard);

    const skip = button('egg__skip', 'Skip  Esc  ✕', skipVideo);
    skip.setAttribute('aria-label', 'Skip the video');

    overlay.append(video, skip);
    skip.focus();

    const p = video.play();
    if (p && p.catch) {
      // the browser refused sound: play muted and offer sound on a tap
      p.catch(() => {
        video.muted = true;
        video.play().catch(() => {});
        const sound = button('egg__sound', '🔊 Tap for sound', () => {
          video.muted = false;
          sound.remove();
        });
        overlay.appendChild(sound);
      });
    }
  }

  function skipVideo() {
    if (!overlay) return;
    const v = overlay.querySelector('video');
    if (v) {
      v.pause();
      showEndCard();
    } else {
      close();
    }
  }

  function showEndCard() {
    if (!overlay) return;
    const v = overlay.querySelector('video');
    if (v) v.pause();
    overlay.textContent = '';
    const card = el('div', 'egg__card');
    card.append(
      el('p', 'egg__kicker', '> access granted_'),
      el('h2', 'egg__title', 'You found the secret.'),
      el('p', 'egg__text', 'Welcome to the inside, Viberator. Matrix mode stays on for the rest of your visit.')
    );
    const row = el('div', 'egg__row');
    row.append(
      button('egg__btn egg__btn--primary', 'Enter Matrix mode', () => {
        close();
        setMatrix(true);
      }),
      button('egg__btn', 'Back to normal', close)
    );
    card.append(row, button('egg__again', 'Watch it again', playVideo));
    overlay.appendChild(card);
    row.firstChild.focus();
  }

  function close() {
    if (!overlay) return;
    const v = overlay.querySelector('video');
    if (v) v.pause();
    overlay.remove();
    overlay = null;
    document.documentElement.classList.remove('egg-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // ---------- Matrix mode ----------

  let rain = null;
  let exitBtn = null;

  function setMatrix(on) {
    const root = document.documentElement;
    root.classList.toggle('matrix-mode', on);
    try {
      if (on) sessionStorage.setItem(STORE_KEY, '1');
      else sessionStorage.removeItem(STORE_KEY);
    } catch {}
    renameHeadings(on);
    if (on) {
      startRain();
      if (!exitBtn) {
        exitBtn = button('matrix-exit', '[ exit matrix mode ]', () => setMatrix(false));
        document.body.appendChild(exitBtn);
      }
    } else {
      stopRain();
      if (exitBtn) exitBtn.remove();
      exitBtn = null;
    }
  }

  // Section headings read like folders in Matrix mode ("About Me" -> /about_me)
  function renameHeadings(on) {
    document.querySelectorAll('main h2, .section__title, .panel__heading').forEach((h) => {
      if (on) {
        if (h.dataset.eggOriginal !== undefined) return;
        h.dataset.eggOriginal = h.innerHTML;
        h.textContent = '/' + h.textContent.trim().toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      } else if (h.dataset.eggOriginal !== undefined) {
        h.innerHTML = h.dataset.eggOriginal;
        delete h.dataset.eggOriginal;
      }
    });
  }

  function startRain() {
    if (rain) return;
    const canvas = el('canvas', 'matrix-rain');
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
    const ctx = canvas.getContext('2d');
    const glyphs = 'VIBESBYVINCE01アイウエオカキクケコサシスセソタチツテト';
    const size = 18;
    let cols = [];
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      cols = Array.from({ length: Math.ceil(canvas.width / size) }, () => Math.floor((Math.random() * -canvas.height) / size));
      if (reduceMotion) drawStill();
    };
    const drawRow = () => {
      ctx.font = `${size}px ui-monospace, Consolas, monospace`;
      for (let i = 0; i < cols.length; i++) {
        const ch = glyphs[(Math.random() * glyphs.length) | 0];
        const y = cols[i] * size;
        ctx.fillStyle = Math.random() > 0.96 ? '#e6ffe9' : '#22e05a';
        ctx.fillText(ch, i * size, y);
        cols[i] = y > canvas.height && Math.random() > 0.975 ? 0 : cols[i] + 1;
      }
    };
    // reduced motion: one still frame of code instead of falling rain
    const drawStill = () => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let n = 0; n < 60; n++) {
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawRow();
      }
    };
    let raf = 0;
    let last = 0;
    const tick = (t) => {
      raf = requestAnimationFrame(tick);
      if (document.hidden || t - last < 50) return; // ~20 fps, paused in background tabs
      last = t;
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawRow();
    };
    window.addEventListener('resize', resize);
    resize();
    if (!reduceMotion) raf = requestAnimationFrame(tick);
    rain = { canvas, stop: () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); canvas.remove(); } };
  }

  function stopRain() {
    if (rain) rain.stop();
    rain = null;
  }

  // keep Matrix mode on across pages for the rest of the visit
  let saved = false;
  try {
    saved = sessionStorage.getItem(STORE_KEY) === '1';
  } catch {}
  if (saved) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setMatrix(true));
    else setMatrix(true);
  }
})();
