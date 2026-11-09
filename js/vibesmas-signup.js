// VibesByVince — Vibesmas sign-up and private status page
// (/vibesmas/signup, and /vibesmas/signup#k=<key> for a duo's own status).
// The private key lives in the link's #fragment, which browsers never send
// to the server or to other sites. It's also remembered in this browser so
// the captain can come back without the link.

(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const KEY_STORE = 'vbv-vibesmas-key';
  let key = null;
  let current = null; // the duo as last loaded

  $('year').textContent = new Date().getFullYear();

  const ERRORS = {
    name_required: 'Give your duo a name.',
    name_too_long: 'Duo names can be up to 32 characters.',
    name_taken: 'Another duo already has that name. Pick a different one.',
    streamer_required: "Pick who's streaming on Twitch.",
    epic_required: (p) => `Enter Player ${p}'s Epic name (3 to 16 characters).`,
    twitch_required: (p) => `Player ${p} is streaming, so their Twitch name is needed.`,
    twitch_invalid: (p) => `Player ${p}'s Twitch name doesn't look right. Use just the name, like vibesbyvince.`,
    twitch_not_found: (p) => `There's no Twitch channel with Player ${p}'s name. Check the spelling.`,
    discord_invalid: (p) => `Player ${p}'s Discord name doesn't look right. Use the username, like vibesbyvince.`,
    discord_required: 'At least one of you needs a Discord name, for check-in and screenshots.',
    same_player: 'Player 1 and Player 2 need to be different people.',
    player_taken: (p) => `Player ${p} is already signed up with another duo.`,
    confirm_required: 'Tick all three boxes to confirm.',
    registration_closed: 'Registration is closed.',
    full: 'All 40 spots are filled.',
    too_many: 'Too many sign-ups from your network today. Try again tomorrow or ask in Discord.',
    locked: "Your duo is approved, so it's locked. Ask Vince in Discord if something needs to change.",
    bad_origin: 'That request was blocked. Reload the page and try again.',
    not_found: "That status link doesn't match a sign-up. It may have been withdrawn.",
  };
  const FIELD_FOR = {
    name_required: 'name', name_too_long: 'name', name_taken: 'name',
    epic_required: 'epic', twitch_required: 'twitch', twitch_invalid: 'twitch', twitch_not_found: 'twitch',
    discord_invalid: 'discord', player_taken: 'epic',
  };

  function message(data) {
    const m = ERRORS[data && data.error];
    if (typeof m === 'function') return m(data.player);
    return m || (data && data.message) || 'Something went wrong. Try again in a minute.';
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: opts.body ? { 'content-type': 'application/json' } : {},
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      const err = new Error(message(data));
      err.data = data || {};
      throw err;
    }
    return data;
  }

  // ---------- form ----------

  const field = (name) => form.elements[name];

  function syncRequired() {
    const s = form.elements.streams.value;
    $('form').querySelector('[data-req="p1-twitch"]').textContent = s === 'p1' || s === 'both' ? 'required' : 'optional';
    $('form').querySelector('[data-req="p2-twitch"]').textContent = s === 'p2' || s === 'both' ? 'required' : 'optional';
  }
  form.querySelectorAll('input[name="streams"]').forEach((r) => r.addEventListener('change', syncRequired));

  function clearErrors() {
    $('form-error').hidden = true;
    form.querySelectorAll('[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
  }

  function showError(err) {
    $('form-error').textContent = err.message;
    $('form-error').hidden = false;
    const d = err.data || {};
    const kind = FIELD_FOR[d.error];
    let input = null;
    if (kind === 'name') input = field('name');
    else if (kind && d.player) input = field(`p${d.player}-${kind}`);
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    } else {
      $('form-error').scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function readForm() {
    const v = (n) => field(n).value.trim();
    return {
      name: v('name'),
      streams: form.elements.streams.value,
      p1: { epic: v('p1-epic'), twitch: v('p1-twitch'), discord: v('p1-discord') },
      p2: { epic: v('p2-epic'), twitch: v('p2-twitch'), discord: v('p2-discord') },
      age21: field('age21').checked,
      streamVod: field('streamVod').checked,
      rules: field('rules').checked,
      website: field('website').value,
    };
  }

  function fillForm(d) {
    field('name').value = d.name;
    form.querySelector(`input[name="streams"][value="${d.streams}"]`).checked = true;
    for (const p of ['p1', 'p2']) {
      field(`${p}-epic`).value = d[p].epic || '';
      field(`${p}-twitch`).value = d[p].twitch || '';
      field(`${p}-discord`).value = d[p].discord || '';
    }
    ['age21', 'streamVod', 'rules'].forEach((n) => (field(n).checked = true));
    syncRequired();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    const btn = $('submit');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Sending…';
    try {
      if (key) {
        const r = await api(`/api/vibesmas/status?t=${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(readForm()) });
        current = r.duo;
      } else {
        const r = await api('/api/vibesmas/signup', { method: 'POST', body: JSON.stringify(readForm()) });
        key = r.token;
        try {
          localStorage.setItem(KEY_STORE, key);
        } catch {}
        history.replaceState(null, '', `#k=${key}`);
        current = (await api(`/api/vibesmas/status?t=${encodeURIComponent(key)}`)).duo;
      }
      showStatus(true);
    } catch (err) {
      showError(err);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  $('cancel-edit').addEventListener('click', () => showStatus());

  // ---------- status ----------

  const STATUS = {
    pending: ['Waiting for approval', 'vm-badge--pending'],
    approved: ['Approved', 'vm-badge--approved'],
    declined: ['Not approved', 'vm-badge--declined'],
  };

  function playerSummary(p, n, streams) {
    const bits = [`Epic: ${p.epic}`];
    if (p.twitch) bits.push(`Twitch: ${p.twitch}`);
    if (p.discord) bits.push(`Discord: ${p.discord}`);
    const streaming = streams === 'both' || streams === `p${n}`;
    return { title: `Player ${n}${streaming ? ' · streaming' : ''}`, text: bits.join(' · ') };
  }

  function showStatus(justSaved = false) {
    const d = current;
    form.hidden = true;
    $('loading').hidden = true;
    $('status').hidden = false;
    $('page-title').textContent = d.name;
    $('page-intro').textContent = 'Your Vibesmas sign-up.';

    const [label, cls] = STATUS[d.status] || STATUS.pending;
    $('st-badge').textContent = label;
    $('st-badge').className = `vm-badge ${cls}`;
    $('st-title').textContent =
      d.status === 'approved' ? "You're on the roster" : d.status === 'declined' ? 'This sign-up was not approved' : justSaved ? "You're in the queue" : 'Waiting for Vince to review it';
    $('st-text').textContent =
      d.status === 'approved'
        ? 'See you on Saturday, December 12. Check in on Discord by 9:45 AM MST.'
        : d.status === 'declined'
          ? 'Read the note below. If it can be fixed, edit your duo and it goes back into the queue.'
          : 'Vince will review your duo soon. Come back to this page any time to check.';
    $('st-note').hidden = !d.note;
    $('st-note').textContent = d.note ? `Note from Vince: ${d.note}` : '';

    const dl = $('st-details');
    dl.textContent = '';
    [playerSummary(d.p1, 1, d.streams), playerSummary(d.p2, 2, d.streams)].forEach((s) => {
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = s.title;
      const dd = document.createElement('dd');
      dd.textContent = s.text;
      div.append(dt, dd);
      dl.append(div);
    });

    $('st-link').textContent = `${location.origin}/vibesmas/signup#k=${key}`;
    $('st-edit').hidden = !d.canEdit;
    $('st-withdraw').hidden = false;
    $('st-confirm').hidden = true;
    if (justSaved) $('status').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  $('st-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('st-link').textContent);
      $('st-copy').textContent = 'Copied';
    } catch {
      const r = document.createRange();
      r.selectNodeContents($('st-link'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      $('st-copy').textContent = 'Press Ctrl+C';
    }
    setTimeout(() => ($('st-copy').textContent = 'Copy link'), 2500);
  });

  $('st-edit').addEventListener('click', () => {
    fillForm(current);
    clearErrors();
    $('status').hidden = true;
    form.hidden = false;
    $('submit').textContent = current.status === 'declined' ? 'Send again' : 'Save changes';
    $('cancel-edit').hidden = false;
    $('submit-note').hidden = true;
    field('name').focus();
  });

  $('st-withdraw').addEventListener('click', () => {
    $('st-withdraw').hidden = true;
    $('st-confirm').hidden = false;
  });
  $('st-withdraw-no').addEventListener('click', () => {
    $('st-withdraw').hidden = false;
    $('st-confirm').hidden = true;
  });
  $('st-withdraw-yes').addEventListener('click', async () => {
    try {
      await api(`/api/vibesmas/status?t=${encodeURIComponent(key)}`, { method: 'DELETE' });
      try {
        localStorage.removeItem(KEY_STORE);
      } catch {}
      key = null;
      current = null;
      history.replaceState(null, '', location.pathname);
      $('status').hidden = true;
      $('page-title').textContent = 'Sign up your duo';
      $('page-intro').textContent = 'Your duo was withdrawn. You can sign up again any time before registration closes.';
      startForm();
    } catch (err) {
      $('st-text').textContent = err.message;
    }
  });

  // ---------- start ----------

  function startForm() {
    form.reset();
    syncRequired();
    $('submit').textContent = 'Send for approval';
    $('cancel-edit').hidden = true;
    $('submit-note').hidden = false;
    $('loading').hidden = true;
    form.hidden = false;
  }

  async function checkOpen() {
    try {
      const s = await api('/api/vibesmas');
      $('spots').textContent = `${s.approved} of ${s.maxDuos} duos approved · closes Dec 5, 11:59 PM MST`;
      if (!s.regOpen) {
        $('closed').textContent =
          s.approved >= s.maxDuos ? 'All 40 spots are filled. Thanks for the love!' : 'Registration is closed. See you at the tournament on December 12!';
        $('closed').hidden = false;
        return false;
      }
    } catch {}
    return true;
  }

  async function init() {
    const m = /(?:^|[#&])k=([A-Za-z0-9_-]{20,40})/.exec(location.hash);
    let stored = null;
    try {
      stored = localStorage.getItem(KEY_STORE);
    } catch {}
    key = m ? m[1] : stored;

    if (key) {
      try {
        current = (await api(`/api/vibesmas/status?t=${encodeURIComponent(key)}`)).duo;
        if (!m) history.replaceState(null, '', `#k=${key}`);
        try {
          localStorage.setItem(KEY_STORE, key);
        } catch {}
        showStatus();
        return;
      } catch (err) {
        if (m) {
          $('loading').hidden = true;
          $('closed').textContent = err.message;
          $('closed').hidden = false;
        }
        try {
          if (stored === key) localStorage.removeItem(KEY_STORE);
        } catch {}
        key = null;
        if (m) return;
      }
    }
    if (await checkOpen()) startForm();
    else $('loading').hidden = true;
  }

  init();
})();
