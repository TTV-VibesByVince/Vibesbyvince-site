// VibesByVince — "Let it snow" toggle for the Vibesmas pages.
// Off by default, remembered in this browser, and never offered to people
// whose device asks for reduced motion.

(() => {
  const buttons = [...document.querySelectorAll('[data-snow-toggle]')];
  if (!buttons.length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const KEY = 'vbv-vibesmas-snow';

  let canvas = null;
  let raf = 0;
  let flakes = [];

  function size() {
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
  }

  function start() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.className = 'vm-snow';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.append(canvas);
    size();
    addEventListener('resize', size);
    const n = Math.round(Math.min(120, innerWidth / 12));
    flakes = Array.from({ length: n }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 1 + Math.random() * 2.4,
      s: 0.0006 + Math.random() * 0.0012,
      d: Math.random() * Math.PI * 2,
    }));
    const ctx = canvas.getContext('2d');
    const tick = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      for (const f of flakes) {
        f.y += f.s;
        f.d += 0.01;
        if (f.y > 1.02) {
          f.y = -0.02;
          f.x = Math.random();
        }
        ctx.beginPath();
        ctx.arc((f.x + Math.sin(f.d) * 0.01) * w, f.y * h, f.r * devicePixelRatio, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function stop() {
    cancelAnimationFrame(raf);
    removeEventListener('resize', size);
    if (canvas) canvas.remove();
    canvas = null;
  }

  function set(on) {
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {}
    buttons.forEach((b) => {
      b.setAttribute('aria-pressed', String(on));
      b.textContent = on ? 'Stop the snow' : 'Let it snow';
    });
    if (on) start();
    else stop();
  }

  let on = false;
  try {
    on = localStorage.getItem(KEY) === '1';
  } catch {}
  buttons.forEach((b) => {
    b.hidden = false;
    b.addEventListener('click', () => set(b.getAttribute('aria-pressed') !== 'true'));
  });
  set(on);
})();
