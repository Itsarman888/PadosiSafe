import { $, $$, h, clear } from './js/dom.mjs';
import { api, ApiError } from './js/api.mjs';
import { createMap, unavailableMap } from './js/map.mjs';
import { searchPlaces, reverseGeocode } from './js/geo.mjs';
import {
  CATEGORY_META, SEVERITY_META, PLACE_META, CITIES, FALLBACK_CONFIG,
  timeAgo, formatDuration, formatDistance, inBounds, round5, osmLink, debounce,
  memberStatusView, intervalLabel, graceLabel, awayLabel,
} from './js/util.mjs';

// ---------------------------------------------------------------- state

const S = {
  config: FALLBACK_CONFIG,
  clientId: null,
  session: null, // { code, token }
  circle: null,
  pin: null, // { lat, lng }
  pinLabel: '',
  radiusKm: '',
  tab: 'circle',
  alerts: [],
  places: [],
  skew: 0,
  map: null,
  sosOpen: false,
  lastGuide: null,
};

const now = () => Date.now() + S.skew;

// ---------------------------------------------------------------- storage (safe if blocked)

let memoryFallback = {};
function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return memoryFallback[key] ?? null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { memoryFallback[key] = value; }
}
function lsDel(key) {
  try { localStorage.removeItem(key); } catch { delete memoryFallback[key]; }
}

function getClientId() {
  const existing = lsGet('ps_client');
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  const id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 32).padEnd(16, 'x');
  lsSet('ps_client', id);
  return id;
}

function loadSession() {
  try {
    const s = JSON.parse(lsGet('ps_session') || 'null');
    return s && s.code && s.token ? s : null;
  } catch { return null; }
}
function saveSession(s) {
  S.session = s;
  if (s) lsSet('ps_session', JSON.stringify(s)); else lsDel('ps_session');
}

function loadPin() {
  try {
    const p = JSON.parse(lsGet('ps_pin') || 'null');
    return p && inBounds(p.lat, p.lng, S.config.bounds) ? p : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- small UI helpers

let toastTimer;
function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${bad ? ' bad' : ''}`;
  el.hidden = false;
  el.setAttribute('role', bad ? 'alert' : 'status');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 7000 : 4000);
}

/** Runs an async action from a button: disables it, reports errors in plain words. */
async function run(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.', true);
    if (!(e instanceof ApiError)) console.error(e);
    return undefined;
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
}

function select(id, options, value, label) {
  const el = h('select', { id }, options.map(([v, text]) => h('option', { value: String(v) }, text)));
  el.value = String(value);
  if (label) el.setAttribute('aria-label', label);
  return el;
}

function field(label, control, hint) {
  return h('div', { class: 'field' },
    h('label', { for: control.id }, label),
    control,
    hint ? h('p', { class: 'hint' }, hint) : null);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

function originQuery() {
  const q = { clientId: S.clientId };
  if (S.pin) {
    q.lat = S.pin.lat;
    q.lng = S.pin.lng;
    if (S.radiusKm) q.radiusKm = S.radiusKm;
  }
  return q;
}

function guideCard(category, severity) {
  const steps = (S.config.playbooks || {})[category] || (S.config.playbooks || {}).other || [];
  const meta = CATEGORY_META[category] || CATEGORY_META.other;
  return h('div', { class: 'guide', role: 'region', 'aria-label': 'What to do now' },
    h('h3', {}, `What to do now: ${meta.label.toLowerCase()}`),
    severity === 'urgent' ? h('p', {}, h('a', { class: 'btn btn-danger btn-small', href: 'tel:112' }, 'Call 112 now')) : null,
    steps.length ? h('ol', {}, steps.map((t) => h('li', {}, t))) : null,
    h('p', { class: 'hint' }, 'General community guidance, not professional advice.'));
}

// ---------------------------------------------------------------- location bar

async function setPin(lat, lng, { label = '', fly = false, zoom = 14 } = {}) {
  lat = round5(lat);
  lng = round5(lng);
  if (!inBounds(lat, lng, S.config.bounds)) {
    toast('That spot is outside India. Pick a place on the map of India.', true);
    return false;
  }
  S.pin = { lat, lng };
  S.pinLabel = label;
  lsSet('ps_pin', JSON.stringify(S.pin));
  S.map.setPin(lat, lng);
  if (fly) S.map.flyTo(lat, lng, zoom);
  $('#radiusSelect').disabled = false;
  updatePinStatus();
  applyRadius();
  reloadNearby();
  if (!label) lookupLabel(lat, lng);
  return true;
}

let labelAbort;
const lookupLabel = debounce(async (lat, lng) => {
  labelAbort?.abort();
  labelAbort = new AbortController();
  try {
    const label = await reverseGeocode(lat, lng, labelAbort.signal);
    if (label && S.pin && S.pin.lat === lat && S.pin.lng === lng) {
      S.pinLabel = label;
      updatePinStatus();
    }
  } catch { /* the label is a nicety */ }
}, 700);

function updatePinStatus() {
  const el = $('#pinStatus');
  clear(el);
  if (!S.pin) {
    el.append('No pin yet. Search, pick a city, use your location, or tap the map.');
    return;
  }
  el.append(h('strong', {}, S.pinLabel || 'Pin dropped'), ` (${S.pin.lat.toFixed(4)}, ${S.pin.lng.toFixed(4)}). Drag the pin to adjust it.`);
}

function applyRadius() {
  const km = Number(S.radiusKm) || 0;
  S.map.setRadius(km, S.pin?.lat, S.pin?.lng);
}

function initWhereBar() {
  const chips = $('#cityChips');
  CITIES.forEach((c) => {
    chips.append(h('button', {
      class: 'chip', type: 'button', 'aria-pressed': 'false',
      onClick: async (e) => {
        $$('.chip', chips).forEach((b) => b.setAttribute('aria-pressed', 'false'));
        e.currentTarget.setAttribute('aria-pressed', 'true');
        S.map.flyTo(c.lat, c.lng, 11);
        await setPin(c.lat, c.lng, { label: c.name });
      },
    }, c.name));
  });

  const results = $('#searchResults');
  let controller;
  async function doSearch() {
    const q = $('#searchInput').value.trim();
    if (q.length < 3) { toast('Type at least 3 letters to search.', true); return; }
    controller?.abort();
    controller = new AbortController();
    clear(results);
    results.hidden = false;
    results.append(h('li', { class: 'none' }, 'Searching…'));
    try {
      const rows = await searchPlaces(q, controller.signal);
      clear(results);
      if (!rows.length) {
        results.append(h('li', { class: 'none' }, 'No match in India. Try a nearby landmark or a bigger area name.'));
        return;
      }
      rows.forEach((r) => results.append(h('li', {}, h('button', {
        type: 'button',
        onClick: async () => {
          results.hidden = true;
          if (await setPin(r.lat, r.lng, { label: r.label, fly: true, zoom: 15 })) $('#searchInput').value = '';
        },
      }, r.label))));
      results.querySelector('button')?.focus();
    } catch (e) {
      if (e.name === 'AbortError') return;
      clear(results);
      results.append(h('li', { class: 'none' }, 'Search is not available right now. Tap the map to drop a pin instead.'));
    }
  }
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch(); });
  $('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') results.hidden = true; });

  $('#gpsBtn').addEventListener('click', (e) => {
    if (!navigator.geolocation) { toast('Your browser cannot share location. Search or tap the map instead.', true); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        btn.disabled = false;
        btn.textContent = 'Use my location';
        await setPin(pos.coords.latitude, pos.coords.longitude, { label: 'Your location', fly: true, zoom: 16 });
      },
      (err) => {
        btn.disabled = false;
        btn.textContent = 'Use my location';
        toast(err.code === 1
          ? 'Location is blocked. Allow it in your browser settings, or search and tap the map instead.'
          : 'Could not find your location. Search or tap the map instead.', true);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });

  $('#radiusSelect').addEventListener('change', (e) => {
    S.radiusKm = e.target.value;
    applyRadius();
    reloadNearby();
  });
}

// ---------------------------------------------------------------- tabs

function showTab(name, focus = false) {
  S.tab = name;
  $$('.tabs [role="tab"]').forEach((t) => {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  });
  $$('.pane').forEach((p) => { p.hidden = p.id !== `pane-${name}`; });
  updateLayers();
  if (name === 'alerts') loadAlerts();
  if (name === 'places') loadPlaces();
}

function initTabs() {
  const tabs = $$('.tabs [role="tab"]');
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => showTab(t.dataset.tab));
    t.addEventListener('keydown', (e) => {
      const key = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (key) {
        e.preventDefault();
        showTab(tabs[(i + key + tabs.length) % tabs.length].dataset.tab, true);
      }
    });
  });
}

function updateLayers() {
  S.map.setLayers({ alerts: S.tab === 'alerts', places: S.tab === 'places', sos: S.tab === 'circle' });
}

// ---------------------------------------------------------------- circle tab

function circleHeader(c) {
  const url = location.origin + location.pathname;
  const shareText = `Join my PadosiSafe neighbour circle. Open ${url} and use the code ${c.code}.`;
  return h('div', { class: 'codebox' },
    h('div', {}, h('small', {}, `Circle: ${c.name}`), h('span', { class: 'code', id: 'circleCode' }, c.code), h('small', {}, `${c.members.length} of ${c.maxMembers} neighbours${c.area ? `, ${c.area}` : ''}`)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-small', type: 'button', onClick: async () => toast((await copyText(c.code)) ? 'Code copied. Send it to your neighbours.' : 'Could not copy. Read the code out instead.') }, 'Copy code'),
      navigator.share ? h('button', { class: 'btn btn-small', type: 'button', onClick: () => navigator.share({ title: 'PadosiSafe', text: shareText, url }).catch(() => {}) }, 'Share') : null));
}

function heroCard(me, c) {
  const st = me.status;
  const tone = st.state === 'ok' ? '' : `is-${st.state}`;
  let progress = 1;
  let line;
  if (st.state === 'ok') {
    const total = me.intervalHours * 3_600_000;
    progress = Math.max(0.02, Math.min(1, (st.dueAt - now()) / total));
    line = h('p', { class: 'when' }, 'Next check-in due in ', h('strong', {}, formatDuration(st.dueAt - now())));
  } else if (st.state === 'due') {
    line = h('p', { class: 'when' }, h('strong', {}, 'Your check-in is due. '), `Your circle is alerted if you do not check in within ${graceLabel(me.graceMinutes)}.`);
  } else if (st.state === 'missed') {
    line = h('p', { class: 'when' }, h('strong', {}, 'You missed a check-in. '), 'Tap the button so your circle knows you are okay.');
  } else if (st.state === 'sos') {
    line = h('p', { class: 'when' }, h('strong', {}, 'Your SOS is active. '), 'Tap the button when you are safe. If you need help, call 112.');
  } else {
    progress = 1;
    line = h('p', { class: 'when' }, h('strong', {}, `You are away. `), `Check-ins resume in ${formatDuration(st.until - now())}.`);
  }
  const label = st.state === 'away' ? ['I am back', 'End away mode'] : st.state === 'sos' ? ['I am safe', 'Cancel my SOS'] : ["I'm okay", 'Tap to check in'];
  const ring = h('div', { class: `ring ${tone}`, style: `--p:${progress}` },
    h('button', {
      class: 'ring-btn', type: 'button', 'data-key': 'checkin',
      onClick: (e) => run(e.currentTarget, async () => {
        const path = st.state === 'away' ? 'away' : 'checkin';
        const body = st.state === 'away' ? { hours: 0 } : {};
        const r = await api('POST', `/api/circles/${c.code}/${path}`, { body, token: S.session.token });
        applyCircle(r.circle);
        toast(st.state === 'away' ? 'Welcome back.' : 'Checked in. Your circle can see you are okay.');
      }),
    }, label[0], h('small', {}, label[1])));
  return h('div', { class: 'card hero' }, ring, line);
}

function sosCard(c) {
  if (!S.sosOpen) {
    return h('button', { class: 'btn btn-danger sos-btn btn-block', type: 'button', 'data-key': 'sos-open', onClick: () => { S.sosOpen = true; renderCircleDynamic(); $('#sosNote')?.focus(); } }, 'Send SOS to my circle');
  }
  const note = h('input', { id: 'sosNote', type: 'text', maxlength: '140', placeholder: 'Optional: what is wrong? e.g. fell, cannot get up' });
  return h('form', {
    class: 'card',
    onSubmit: (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        let loc = null;
        if (navigator.geolocation) {
          loc = await new Promise((resolve) => navigator.geolocation.getCurrentPosition(
            (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve(null), { timeout: 4000, maximumAge: 120000 }));
        }
        if (!loc && S.pin) loc = S.pin;
        const r = await api('POST', `/api/circles/${c.code}/sos`, { token: S.session.token, body: { note: note.value, lat: loc?.lat, lng: loc?.lng } });
        S.sosOpen = false;
        applyCircle(r.circle);
        toast('SOS sent to your circle. If you need urgent help, call 112 now.');
      });
    },
  },
  h('h2', {}, 'Send an SOS'),
  h('p', { class: 'notice bad' }, 'This alerts your neighbours. It does not call emergency services. If you are in danger, call 112 first.'),
  h('a', { class: 'btn btn-emergency btn-block', href: 'tel:112' }, 'Call 112'),
  h('div', { class: 'field' }, h('label', { for: 'sosNote' }, 'Short note (optional)'), note, h('p', { class: 'hint' }, 'We add your current location if your browser allows it.')),
  h('div', { class: 'actions' },
    h('button', { class: 'btn btn-danger', type: 'submit' }, 'Send SOS now'),
    h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => { S.sosOpen = false; renderCircleDynamic(); } }, 'Cancel')));
}

function memberRow(m, c) {
  const v = memberStatusView(m.status, now());
  const needsHelp = ['due', 'missed', 'sos'].includes(m.status.state);
  const claimedByMe = m.claim && m.claim.byId === c.you;
  const actions = [];
  if (!m.isYou && needsHelp) {
    if (!m.claim) {
      actions.push(h('button', {
        class: 'btn btn-small', type: 'button',
        onClick: (e) => run(e.currentTarget, async () => {
          const r = await api('POST', `/api/circles/${c.code}/members/${m.id}/claim`, { token: S.session.token, body: {} });
          applyCircle(r.circle);
          toast(`Thanks. ${m.name} knows someone is checking in.`);
        }),
      }, `I'll check on ${m.name}`));
    }
    if (!m.claim || claimedByMe) {
      actions.push(h('button', {
        class: 'btn btn-small btn-ghost', type: 'button',
        onClick: (e) => run(e.currentTarget, async () => {
          const r = await api('POST', `/api/circles/${c.code}/members/${m.id}/resolve`, { token: S.session.token, body: {} });
          applyCircle(r.circle);
          toast(r.demoNote || `Marked ${m.name} as okay.`);
        }),
      }, `${m.name} is fine`));
    }
  }
  if (m.sos && m.sos.lat !== null) {
    actions.push(h('button', { class: 'btn btn-small btn-ghost', type: 'button', onClick: () => { S.map.flyTo(m.sos.lat, m.sos.lng, 17); } }, 'Show on map'));
    actions.push(h('a', { class: 'btn btn-small btn-ghost', href: osmLink(m.sos.lat, m.sos.lng), target: '_blank', rel: 'noopener' }, 'Open in OpenStreetMap'));
  }
  return h('li', { class: `member t-${v.tone}`, 'data-member': m.id },
    h('div', { class: 'member-head' },
      h('span', { class: 'member-name' }, m.name, m.isYou ? h('span', { class: 'you' }, ' (you)') : null, m.simulated ? h('span', { class: 'sample' }, 'Sample') : null),
      h('span', { class: `pill ${v.tone}` }, h('i', { 'aria-hidden': 'true' }, v.icon), v.label)),
    h('p', { class: 'member-detail' }, v.detail),
    m.sos && m.sos.note ? h('p', { class: 'member-note' }, `“${m.sos.note}”`) : null,
    m.claim ? h('p', { class: 'claimed' }, claimedByMe ? 'You are checking on them.' : `${m.claim.byName} is checking on them.`) : null,
    actions.length ? h('div', { class: 'actions' }, actions) : null);
}

function circleSettings(c) {
  const me = c.members.find((m) => m.isYou);
  const interval = select('setInterval', S.config.intervalHours.map((x) => [x, `Every ${intervalLabel(x)}`]), me.intervalHours);
  const grace = select('setGrace', S.config.graceMinutes.map((x) => [x, graceLabel(x)]), me.graceMinutes);
  const away = select('setAway', [[0, 'Choose…'], ...S.config.awayHours.map((x) => [x, awayLabel(x)])], 0);
  return h('details', { class: 'card' },
    h('summary', { class: 'linklike' }, 'My check-in settings'),
    h('form', {
      class: 'stack',
      onSubmit: (e) => {
        e.preventDefault();
        run(e.submitter, async () => {
          const r = await api('POST', `/api/circles/${c.code}/settings`, { token: S.session.token, body: { intervalHours: Number(interval.value), graceMinutes: Number(grace.value) } });
          applyCircle(r.circle);
          toast('Settings saved.');
        });
      },
    },
    h('div', { class: 'row2' }, field('Check in', interval), field('Alert my circle after', grace)),
    h('button', { class: 'btn btn-small', type: 'submit' }, 'Save settings')),
    h('form', {
      class: 'stack',
      onSubmit: (e) => {
        e.preventDefault();
        if (Number(away.value) === 0) { toast('Choose how long you will be away.', true); return; }
        run(e.submitter, async () => {
          const r = await api('POST', `/api/circles/${c.code}/away`, { token: S.session.token, body: { hours: Number(away.value) } });
          applyCircle(r.circle);
          toast('Away mode on. Your circle will not be alerted while you are away.');
        });
      },
    },
    field('Going away or travelling?', away, 'Pause check-ins so nobody worries.'),
    h('button', { class: 'btn btn-small btn-ghost', type: 'submit' }, 'Pause check-ins')),
    h('button', {
      class: 'btn btn-small btn-ghost', type: 'button',
      onClick: (e) => {
        if (!confirm('Leave this circle? You can join again later with the code.')) return;
        run(e.currentTarget, async () => {
          await api('POST', `/api/circles/${c.code}/leave`, { token: S.session.token, body: {} });
          saveSession(null);
          S.circle = null;
          renderCircleShell();
          toast('You left the circle.');
        });
      },
    }, 'Leave this circle'));
}

function renderCircleShell() {
  const pane = $('#pane-circle');
  clear(pane);
  if (!S.session || !S.circle) { renderCircleStart(pane); return; }
  pane.append(
    h('div', { id: 'cHead' }),
    h('div', { id: 'cAttention' }),
    h('div', { id: 'cHero' }),
    h('div', { id: 'cSos' }),
    h('div', { class: 'card' }, h('h2', {}, 'Your circle'), h('ul', { id: 'cMembers', class: 'members' })),
    circleSettings(S.circle),
    h('div', { class: 'card' }, h('h2', {}, 'Recent activity'), h('ul', { id: 'cEvents', class: 'events' })),
  );
  renderCircleDynamic();
}

function renderCircleDynamic() {
  const c = S.circle;
  if (!c || !$('#cHero')) return;
  const me = c.members.find((m) => m.isYou);
  if (!me) return;
  const focusKey = document.activeElement?.dataset?.key;

  const head = $('#cHead');
  clear(head).append(circleHeader(c));

  const needs = c.members.filter((m) => !m.isYou && ['sos', 'missed'].includes(m.status.state));
  const attention = clear($('#cAttention'));
  if (needs.length) {
    attention.append(h('div', { class: 'notice bad', role: 'alert' }, needs.map((m) => h('p', { key: m.id }, m.status.state === 'sos' ? `${m.name} sent an SOS.` : `${m.name} missed a check-in.`)),
      h('p', {}, 'Please call or visit them. If you cannot reach them, call ', h('a', { href: 'tel:112' }, '112'), '.')));
  }
  document.title = needs.length ? `(${needs.length}) PadosiSafe` : 'PadosiSafe: neighbours looking out for neighbours';

  clear($('#cHero')).append(heroCard(me, c));
  // Don't rebuild an open SOS form on every poll: it would wipe what the person is typing.
  if (!S.sosOpen || !S.sosShown) clear($('#cSos')).append(sosCard(c));
  S.sosShown = S.sosOpen;
  const list = clear($('#cMembers'));
  c.members.forEach((m) => list.append(memberRow(m, c)));
  const ev = clear($('#cEvents'));
  if (!c.events.length) ev.append(h('li', {}, 'Nothing yet.'));
  c.events.forEach((e) => ev.append(h('li', {}, h('time', {}, timeAgo(now() - e.at)), h('span', {}, e.text))));
  if (focusKey) document.querySelector(`[data-key="${focusKey}"]`)?.focus({ preventScroll: true });

  S.map.setSOS(c.members.filter((m) => m.sos && m.sos.lat !== null), () => showTab('circle'));
}

function applyCircle(circle) {
  const first = !S.circle || S.circle.code !== circle.code;
  S.circle = circle;
  S.skew = circle.serverTime - Date.now();
  if (first || !$('#cHero')) renderCircleShell(); else renderCircleDynamic();
}

function renderCircleStart(pane) {
  const startName = h('input', { id: 'cName', type: 'text', maxlength: '40', required: true, placeholder: 'e.g. Lotus Heights, Block B' });
  const yourName = h('input', { id: 'cMe', type: 'text', maxlength: '30', required: true, placeholder: 'Your name or nickname' });
  const area = h('input', { id: 'cArea', type: 'text', maxlength: '60', placeholder: 'Optional, e.g. Andheri West' });
  const interval = select('cInterval', S.config.intervalHours.map((x) => [x, `Every ${intervalLabel(x)}`]), 24);
  const grace = select('cGrace', S.config.graceMinutes.map((x) => [x, graceLabel(x)]), 60);
  const joinCode = h('input', { id: 'jCode', type: 'text', maxlength: '30', required: true, placeholder: 'NEEM-LOTUS-4821', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' });
  const joinName = h('input', { id: 'jName', type: 'text', maxlength: '30', required: true, placeholder: 'Your name or nickname' });

  const join = async (code, name, btn) => run(btn, async () => {
    const r = await api('POST', '/api/circles/join', { body: { code, name } });
    saveSession({ code: r.circle.code, token: r.token });
    applyCircle(r.circle);
    toast(`You joined ${r.circle.name}.`);
  });

  pane.append(
    h('div', { class: 'card' },
      h('h2', {}, 'Look out for each other'),
      h('p', {}, 'A circle is a small group of neighbours who check in with one tap. If someone misses a check-in, the others see it and can go and check on them. No email, no password, no phone number.')),
    h('form', {
      class: 'card',
      onSubmit: (e) => {
        e.preventDefault();
        run(e.submitter, async () => {
          const body = { name: startName.value, memberName: yourName.value, area: area.value, intervalHours: Number(interval.value), graceMinutes: Number(grace.value) };
          if (S.pin) { body.lat = S.pin.lat; body.lng = S.pin.lng; }
          const r = await api('POST', '/api/circles', { body });
          saveSession({ code: r.circle.code, token: r.token });
          applyCircle(r.circle);
          toast('Circle created. Share the code with your neighbours.');
        });
      },
    },
    h('h2', {}, 'Start a circle'),
    field('Circle name', startName),
    field('Your name', yourName, 'Neighbours will see this, so a first name or nickname is fine.'),
    field('Area', area, S.pin ? 'Your map pin will be saved as the circle’s location.' : 'Tip: drop a pin on the map first to save the circle’s location.'),
    h('div', { class: 'row2' }, field('I will check in', interval), field('Alert after', grace)),
    h('button', { class: 'btn btn-block', type: 'submit' }, 'Create circle')),
    h('form', {
      class: 'card',
      onSubmit: (e) => { e.preventDefault(); join(joinCode.value, joinName.value, e.submitter); },
    },
    h('h2', {}, 'Join with a code'),
    field('Circle code', joinCode),
    field('Your name', joinName),
    h('button', { class: 'btn btn-block', type: 'submit' }, 'Join circle')),
    h('div', { class: 'card' },
      h('h2', {}, 'Just looking?'),
      h('p', {}, 'Try the demo circle. It has three sample neighbours: one okay, one running late and one who missed a check-in.'),
      h('button', {
        class: 'btn btn-ghost btn-block', type: 'button',
        onClick: (e) => join(S.config.demoCode, 'Guest', e.currentTarget),
      }, 'Open the demo circle')),
  );
}

async function pollCircle() {
  if (!S.session) return;
  try {
    const r = await api('GET', `/api/circles/${S.session.code}`, { token: S.session.token });
    applyCircle(r.circle);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
      saveSession(null);
      S.circle = null;
      renderCircleShell();
      toast('That circle is no longer available on this device. Join again with the code.', true);
    }
  }
}

// ---------------------------------------------------------------- alerts tab

function renderAlertsShell() {
  const pane = $('#pane-alerts');
  const text = h('textarea', { id: 'aText', maxlength: '280', required: true, placeholder: 'What is happening? e.g. Smell of gas near the lift on the 2nd floor' });
  const cat = select('aCat', [['', 'Detect automatically'], ...S.config.categories.map((k) => [k, (CATEGORY_META[k] || CATEGORY_META.other).label])], '');
  const sev = select('aSev', [['', 'Detect automatically'], ...['urgent', 'watch', 'info'].map((k) => [k, SEVERITY_META[k].label])], '');
  const who = h('input', { id: 'aName', type: 'text', maxlength: '30', placeholder: 'Optional, e.g. Priya from Block C' });
  const preview = h('p', { id: 'aPreview', class: 'hint', 'aria-live': 'polite' }, 'We read your report and suggest a type and urgency. You can change them.');
  const pinNote = h('p', { id: 'aPin', class: 'notice warn' });
  const result = h('div', { id: 'aResult' });
  const formWrap = h('form', {
    id: 'reportForm', class: 'card', hidden: true,
    onSubmit: (e) => {
      e.preventDefault();
      if (!S.pin) { toast('Drop a pin on the map first, so neighbours know where this is.', true); return; }
      run(e.submitter, async () => {
        const r = await api('POST', '/api/alerts', { body: { text: text.value, lat: S.pin.lat, lng: S.pin.lng, clientId: S.clientId, name: who.value, category: cat.value, severity: sev.value } });
        const a = r.alert;
        text.value = ''; cat.value = ''; sev.value = '';
        preview.textContent = 'We read your report and suggest a type and urgency. You can change them.';
        clear(result).append(guideCard(a.category, a.severity));
        toast(`Alert posted: ${SEVERITY_META[a.severity].label}, ${CATEGORY_META[a.category]?.label || 'Other'}.`);
        await loadAlerts();
        S.map.openAlert(a.id);
      });
    },
  },
  h('h2', {}, 'Report something nearby'),
  pinNote,
  field('What is happening?', text, 'Keep it factual. Say only what you have seen yourself.'),
  preview,
  h('div', { class: 'row2' }, field('Type', cat), field('Urgency', sev)),
  field('Your name', who, 'Shown on your alert. Leave blank to post as “Neighbour”.'),
  h('p', { class: 'notice' }, 'If someone is in danger right now, call 112 before you post here.'),
  h('div', { class: 'actions' },
    h('button', { class: 'btn', type: 'submit' }, 'Post alert'),
    h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => { formWrap.hidden = true; $('#reportToggle').focus(); } }, 'Cancel')));

  const detect = debounce(async () => {
    const t = text.value.trim();
    if (t.length < 8) return;
    try {
      const r = await api('POST', '/api/triage', { body: { text: t } });
      if (text.value.trim() !== t) return;
      preview.textContent = `Looks like: ${(CATEGORY_META[r.category] || CATEGORY_META.other).label}, ${SEVERITY_META[r.severity].label.toLowerCase()}.`;
    } catch { /* optional preview */ }
  }, 700);
  text.addEventListener('input', detect);

  const sevFilter = select('aFilter', [['', 'All urgency levels'], ['urgent', 'Urgent only'], ['watch', 'Be careful and up'], ['info', 'FYI only']], '', 'Filter alerts by urgency');
  sevFilter.addEventListener('change', () => { S.alertFilter = sevFilter.value; renderAlertList(); });
  S.alertFilter = '';

  clear(pane).append(
    h('div', { class: 'card' },
      h('h2', {}, 'Neighbourhood alerts'),
      h('p', { class: 'sub' }, 'Live reports from people nearby, sorted by urgency. Alerts expire on their own, and neighbours can confirm or close them.'),
      h('div', { class: 'actions' }, h('button', { id: 'reportToggle', class: 'btn', type: 'button', onClick: () => { formWrap.hidden = !formWrap.hidden; if (!formWrap.hidden) { updateReportPinNote(); text.focus(); } } }, 'Report an alert')),
      h('div', { class: 'filters' }, sevFilter)),
    formWrap, result,
    h('ul', { id: 'alertList', class: 'list' }));
  updateReportPinNote();
}

function updateReportPinNote() {
  const el = $('#aPin');
  if (!el) return;
  el.textContent = S.pin ? `Your alert will be placed at your pin: ${S.pinLabel || `${S.pin.lat.toFixed(4)}, ${S.pin.lng.toFixed(4)}`}.` : 'Drop a pin first: search, use your location or tap the map where this is happening.';
  el.className = `notice${S.pin ? '' : ' warn'}`;
}

async function loadAlerts() {
  try {
    const r = await api('GET', '/api/alerts', { query: originQuery() });
    S.skew = r.serverTime - Date.now();
    S.alerts = r.alerts;
    renderAlertList();
    const urgent = S.alerts.filter((a) => a.severity === 'urgent').length;
    const badge = $('#alertBadge');
    badge.hidden = urgent === 0;
    badge.textContent = String(urgent);
    badge.setAttribute('aria-label', `${urgent} urgent alerts`);
  } catch (e) {
    if (S.tab === 'alerts') toast(e.message, true);
  }
}

function alertItem(a) {
  const cat = CATEGORY_META[a.category] || CATEGORY_META.other;
  const sev = SEVERITY_META[a.severity] || SEVERITY_META.info;
  const steps = (S.config.playbooks || {})[a.category] || [];
  return h('li', { class: `item sev-${a.severity}`, 'data-alert': a.id },
    h('div', { class: 'item-head' },
      h('span', { class: 'item-emoji', 'aria-hidden': 'true' }, cat.emoji),
      h('div', {},
        h('p', { class: 'item-title' }, a.summary),
        h('div', { class: 'meta' },
          h('span', { class: `tag ${a.severity}` }, `${sev.icon} ${sev.label}`),
          h('span', {}, cat.label),
          h('span', {}, timeAgo(now() - a.createdAt)),
          a.distanceKm !== null ? h('span', {}, `${formatDistance(a.distanceKm)} away`) : null,
          a.demo ? h('span', { class: 'sample' }, 'Sample') : null))),
    a.text && a.text !== a.summary ? h('p', {}, a.text) : null,
    h('p', { class: 'meta' },
      h('span', {}, `Posted by ${a.name}`),
      h('span', {}, a.confirmCount ? `${a.confirmCount} neighbour${a.confirmCount === 1 ? '' : 's'} confirmed` : 'Not confirmed yet')),
    steps.length ? h('details', {}, h('summary', {}, 'What to do now'), h('ol', {}, steps.map((t) => h('li', {}, t)))) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-small btn-ghost', type: 'button', onClick: () => { S.map.openAlert(a.id); $('#map').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }, 'Show on map'),
      h('button', {
        class: 'btn btn-small', type: 'button', disabled: a.youConfirmed || a.youAreAuthor, 'data-key': `confirm-${a.id}`,
        onClick: (e) => run(e.currentTarget, async () => { await api('POST', `/api/alerts/${a.id}/confirm`, { body: { clientId: S.clientId } }); toast('Thanks for confirming.'); await loadAlerts(); }),
      }, a.youAreAuthor ? 'You posted this' : a.youConfirmed ? 'You confirmed' : 'I can confirm this'),
      a.demo ? null : h('button', {
        class: 'btn btn-small btn-ghost', type: 'button', 'data-key': `resolve-${a.id}`,
        onClick: (e) => run(e.currentTarget, async () => {
          const r = await api('POST', `/api/alerts/${a.id}/resolve`, { body: { clientId: S.clientId } });
          toast(r.alert.resolved ? 'Alert closed.' : 'Thanks. One more neighbour must agree to close it.');
          await loadAlerts();
        }),
      }, a.youAreAuthor ? 'Close alert' : 'This is resolved')));
}

function renderAlertList() {
  const list = $('#alertList');
  if (!list) return;
  const rank = { urgent: 2, watch: 1, info: 0 };
  const min = S.alertFilter ? rank[S.alertFilter] : 0;
  const shown = S.alertFilter === 'info' ? S.alerts.filter((a) => a.severity === 'info') : S.alerts.filter((a) => rank[a.severity] >= min && (S.alertFilter !== 'urgent' || a.severity === 'urgent'));
  clear(list);
  if (!shown.length) {
    list.append(h('li', { class: 'empty' }, h('strong', {}, 'No active alerts here'), S.pin && S.radiusKm ? 'Nothing within that distance. Try a wider radius, or report something.' : 'That is good news. If you see a hazard, report it so neighbours know.'));
  } else {
    shown.forEach((a) => list.append(alertItem(a)));
  }
  S.map.setAlerts(shown, (id) => S.map.openAlert(id));
}

// ---------------------------------------------------------------- resources tab

function renderPlacesShell() {
  const pane = $('#pane-places');
  const typeFilter = select('pFilter', [['', 'All resources'], ...S.config.placeTypes.map((k) => [k, (PLACE_META[k] || PLACE_META.shelter).label])], '', 'Filter resources by type');
  S.placeFilter = '';
  typeFilter.addEventListener('change', () => { S.placeFilter = typeFilter.value; loadPlaces(); });

  const type = select('pType', S.config.placeTypes.map((k) => [k, (PLACE_META[k] || PLACE_META.shelter).label]), 'first_aid');
  const name = h('input', { id: 'pName', type: 'text', maxlength: '60', required: true, placeholder: 'e.g. Society office first-aid kit' });
  const note = h('input', { id: 'pNote', type: 'text', maxlength: '140', placeholder: 'Optional, e.g. Ask the security desk' });
  const by = h('input', { id: 'pBy', type: 'text', maxlength: '30', placeholder: 'Optional' });
  const pinNote = h('p', { id: 'pPin', class: 'notice warn' });
  const form = h('form', {
    id: 'placeForm', class: 'card', hidden: true,
    onSubmit: (e) => {
      e.preventDefault();
      if (!S.pin) { toast('Drop a pin on the map first, so people can find it.', true); return; }
      run(e.submitter, async () => {
        await api('POST', '/api/places', { body: { type: type.value, name: name.value, note: note.value, addedBy: by.value, lat: S.pin.lat, lng: S.pin.lng, clientId: S.clientId } });
        name.value = ''; note.value = '';
        form.hidden = true;
        // Show everything again so the new resource is visible even if a filter was on.
        S.placeFilter = '';
        typeFilter.value = '';
        toast('Added. Neighbours can now verify it.');
        await loadPlaces();
      });
    },
  },
  h('h2', {}, 'Add a resource'),
  pinNote,
  field('What is it?', type),
  field('Name', name),
  field('Details', note, 'Where exactly, who to ask, opening hours.'),
  field('Your name', by),
  h('div', { class: 'actions' },
    h('button', { class: 'btn', type: 'submit' }, 'Add resource'),
    h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => { form.hidden = true; $('#placeToggle').focus(); } }, 'Cancel')));

  clear(pane).append(
    h('div', { class: 'card' },
      h('h2', {}, 'Help close to home'),
      h('p', { class: 'sub' }, 'First-aid kits, extinguishers, defibrillators, shelters and trained neighbours, added by the community. Verify what you have seen with your own eyes.'),
      h('div', { class: 'actions' }, h('button', { id: 'placeToggle', class: 'btn', type: 'button', onClick: () => { form.hidden = !form.hidden; if (!form.hidden) { updatePlacePinNote(); name.focus(); } } }, 'Add a resource')),
      h('div', { class: 'filters' }, typeFilter)),
    form,
    h('ul', { id: 'placeList', class: 'list' }));
  updatePlacePinNote();
}

function updatePlacePinNote() {
  const el = $('#pPin');
  if (!el) return;
  el.textContent = S.pin ? `It will be placed at your pin: ${S.pinLabel || `${S.pin.lat.toFixed(4)}, ${S.pin.lng.toFixed(4)}`}.` : 'Drop a pin first: search, use your location or tap the map where it is.';
  el.className = `notice${S.pin ? '' : ' warn'}`;
}

async function loadPlaces() {
  try {
    const q = originQuery();
    if (S.placeFilter) q.type = S.placeFilter;
    const r = await api('GET', '/api/places', { query: q });
    S.places = r.places;
    renderPlaceList();
  } catch (e) {
    if (S.tab === 'places') toast(e.message, true);
  }
}

function renderPlaceList() {
  const list = $('#placeList');
  if (!list) return;
  clear(list);
  if (!S.places.length) {
    list.append(h('li', { class: 'empty' }, h('strong', {}, 'Nothing mapped here yet'), 'Be the first. Add the nearest first-aid kit, extinguisher or shelter.'));
  }
  S.places.forEach((p) => {
    const meta = PLACE_META[p.type] || PLACE_META.shelter;
    list.append(h('li', { class: 'item place', 'data-place': p.id },
      h('div', { class: 'item-head' },
        h('span', { class: 'item-emoji', 'aria-hidden': 'true' }, meta.emoji),
        h('div', {},
          h('p', { class: 'item-title' }, p.name),
          h('div', { class: 'meta' },
            h('span', {}, meta.label),
            p.distanceKm !== null ? h('span', {}, `${formatDistance(p.distanceKm)} away`) : null,
            p.demo ? h('span', { class: 'sample' }, 'Sample') : null))),
      p.note ? h('p', {}, p.note) : null,
      h('p', { class: 'meta' }, h('span', {}, `Added by ${p.addedBy}`), h('span', {}, `${p.verifyCount} neighbour${p.verifyCount === 1 ? '' : 's'} verified`)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-small btn-ghost', type: 'button', onClick: () => { S.map.openPlace(p.id); $('#map').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }, 'Show on map'),
        h('a', { class: 'btn btn-small btn-ghost', href: osmLink(p.lat, p.lng), target: '_blank', rel: 'noopener' }, 'Directions'),
        h('button', {
          class: 'btn btn-small', type: 'button', disabled: p.youVerified, 'data-key': `verify-${p.id}`,
          onClick: (e) => run(e.currentTarget, async () => { await api('POST', `/api/places/${p.id}/verify`, { body: { clientId: S.clientId } }); toast('Thanks for verifying.'); await loadPlaces(); }),
        }, p.youVerified ? 'You verified' : 'I have seen this'))));
  });
  S.map.setPlaces(S.places, (id) => S.map.openPlace(id));
}

// ---------------------------------------------------------------- help tab

function renderHelp() {
  const pane = $('#pane-help');
  clear(pane).append(
    h('div', { class: 'card' },
      h('h2', {}, 'Emergency numbers (India)'),
      h('p', { class: 'sub' }, 'Tap a number to call. 112 works from any phone, even without credit.'),
      h('ul', { class: 'numbers' }, S.config.emergencyNumbers.map((n) => h('li', {}, h('a', { href: `tel:${n.number}` }, h('span', { class: 'num' }, n.number), h('span', {}, n.label)))))),
    h('div', { class: 'card' },
      h('h2', {}, 'How PadosiSafe works'),
      h('ul', { class: 'stack' },
        h('li', {}, h('strong', {}, 'Circles. '), 'A few neighbours check in with one tap. A missed check-in shows up for everyone, and one person says “I’ll check on them” so nobody is left alone and nobody is double-called.'),
        h('li', {}, h('strong', {}, 'Alerts. '), 'Anyone can report a hazard near them. We suggest a type and urgency, neighbours confirm it, and it expires on its own.'),
        h('li', {}, h('strong', {}, 'Resources. '), 'A shared map of first-aid kits, extinguishers, AEDs, shelters and trained first-aiders.'))),
    h('div', { class: 'card' },
      h('h2', {}, 'Your privacy'),
      h('ul', { class: 'stack' },
        h('li', {}, 'No email, phone number or account. A circle is a code and a first name.'),
        h('li', {}, 'Your pin is only used to sort what is near you. It is not stored unless you post an alert, add a resource or send an SOS.'),
        h('li', {}, 'Your device is identified by a random code that we store only as a one-way hash, to stop double votes.'),
        h('li', {}, 'Leave a circle and your name goes with you. When the last person leaves, the circle is deleted.'))));
}

// ---------------------------------------------------------------- polling

function startPolling() {
  setInterval(() => {
    if (document.hidden) return;
    if (S.tab === 'circle') pollCircle();
    if (S.tab === 'alerts') loadAlerts();
    if (S.tab === 'circle' && S.circle) renderCircleDynamic();
  }, 20000);
  // Keep countdowns and "x min ago" labels fresh without hitting the server.
  setInterval(() => {
    if (document.hidden) return;
    if (S.tab === 'circle' && S.circle && !S.sosOpen) renderCircleDynamic();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (S.session) pollCircle();
      loadAlerts();
    }
  });
}

let nearbyTimer;
function reloadNearby() {
  clearTimeout(nearbyTimer);
  nearbyTimer = setTimeout(() => {
    updateReportPinNote();
    updatePlacePinNote();
    if (S.tab === 'alerts') loadAlerts(); else loadAlertBadge();
    if (S.tab === 'places') loadPlaces();
  }, 250);
}

async function loadAlertBadge() {
  try {
    const r = await api('GET', '/api/alerts', { query: { ...originQuery(), severity: 'urgent' } });
    const badge = $('#alertBadge');
    badge.hidden = r.alerts.length === 0;
    badge.textContent = String(r.alerts.length);
    badge.setAttribute('aria-label', `${r.alerts.length} urgent alerts`);
  } catch { /* badge is optional */ }
}

// ---------------------------------------------------------------- boot

async function boot() {
  S.clientId = getClientId();
  S.session = loadSession();

  try {
    S.config = { ...FALLBACK_CONFIG, ...(await api('GET', '/api/config')) };
    S.skew = S.config.serverTime - Date.now();
  } catch (e) {
    toast(e.message, true);
  }

  // The app works straight away with a no-op map; the real map swaps in when Leaflet has loaded.
  S.map = unavailableMap();
  createMap($('#map'), { bounds: S.config.bounds, getNow: now, onPick: (lat, lng) => setPin(lat, lng) }).then((m) => {
    if (!m.available) {
      const note = $('#mapNote');
      note.hidden = false;
      note.textContent = 'The map could not load (check your connection). You can still search for a place, use your location, and use every other feature.';
      $('#map').hidden = true;
      $('.mapwrap').classList.add('no-map');
      document.body.dataset.map = 'unavailable';
      return;
    }
    S.map = m;
    if (S.pin) { m.setPin(S.pin.lat, S.pin.lng); m.flyTo(S.pin.lat, S.pin.lng, 13); applyRadius(); }
    updateLayers();
    renderAlertList();
    renderPlaceList();
    renderCircleDynamic();
    document.body.dataset.map = 'ready';
  }).catch((e) => console.error('Map failed to start', e));

  initWhereBar();
  initTabs();
  renderAlertsShell();
  renderPlacesShell();
  renderHelp();
  renderCircleShell();

  const saved = loadPin();
  if (saved) {
    S.pin = saved;
    S.map.setPin(saved.lat, saved.lng);
    S.map.flyTo(saved.lat, saved.lng, 13);
    $('#radiusSelect').disabled = false;
    updatePinStatus();
    lookupLabel(saved.lat, saved.lng);
  }

  updateLayers();
  if (S.session) await pollCircle();
  loadAlertBadge();
  startPolling();
  document.body.dataset.ready = 'true';
}

boot().catch((e) => {
  console.error(e);
  toast('PadosiSafe could not start. Reload the page. In an emergency, call 112.', true);
});
