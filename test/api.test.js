'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../lib/app');
const { MemoryStore, FileStore, UpstashStore } = require('../lib/store');
const { CSP, SECURITY_HEADERS } = require('../lib/security');
const L = require('../lib/logic');

const START = Date.UTC(2026, 9, 21, 5, 0, 0);

async function boot(options = {}) {
  const clock = { t: START };
  const store = options.store || new MemoryStore();
  const app = createApp({ store, clock: () => clock.t, rateLimit: { read: 10000, write: 10000 }, ...options.app });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* leave null */ }
    return { status: res.status, json, headers: res.headers, text };
  }
  const advance = (ms) => { clock.t += ms; };
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return { call, advance, close, clock, store, app };
}

const DEV = 'device-test-0001';
const auth = (token) => ({ 'x-member-token': token });

test('health, config and security headers', async () => {
  const s = await boot();
  try {
    const h = await s.call('GET', '/api/health');
    assert.equal(h.status, 200);
    assert.equal(h.json.ok, true);
    assert.equal(h.json.store, 'memory');
    assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(h.headers.get('cache-control'), 'no-store');
    assert.equal(h.headers.get('content-security-policy'), CSP);

    const c = await s.call('GET', '/api/config');
    assert.equal(c.json.demoCode, 'DEMO-2026');
    assert.ok(c.json.playbooks.fire.length >= 3);
    assert.ok(c.json.emergencyNumbers.some((n) => n.number === '112'));
    assert.equal(c.json.bounds.south, 6.0);

    assert.equal((await s.call('GET', '/api/nope')).status, 404);
    assert.equal((await s.call('DELETE', '/api/alerts')).status, 405);
  } finally { await s.close(); }
});

test('vercel.json headers stay in sync with lib/security.js', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const headers = Object.fromEntries(vercel.headers[0].headers.map((h) => [h.key, h.value]));
  assert.deepEqual(headers, { ...SECURITY_HEADERS });
  assert.equal(vercel.rewrites[0].destination, '/api');
});

test('seed data: sample alerts are sorted, filterable by radius and severity', async () => {
  const s = await boot();
  try {
    const all = await s.call('GET', '/api/alerts');
    assert.equal(all.json.alerts.length, 6);
    assert.ok(all.json.alerts.every((a) => a.demo));
    assert.equal(all.json.alerts[0].severity, 'urgent'); // urgent first
    assert.ok(all.json.alerts.every((a) => a.distanceKm === null));

    const near = await s.call('GET', '/api/alerts?lat=19.12&lng=72.85&radiusKm=5');
    assert.equal(near.json.alerts.length, 1);
    assert.equal(near.json.alerts[0].category, 'flood');
    assert.ok(near.json.alerts[0].distanceKm < 2);

    const urgent = await s.call('GET', '/api/alerts?severity=urgent');
    assert.deepEqual(urgent.json.alerts.map((a) => a.category), ['gas']);

    // Sample alerts keep a fixed relative age, so they never look stale.
    s.advance(500 * L.HOUR);
    const later = await s.call('GET', '/api/alerts');
    assert.equal(later.json.alerts.length, 6);
    const gas = later.json.alerts.find((a) => a.category === 'gas');
    assert.equal(s.clock.t - gas.createdAt, 8 * L.MIN);
  } finally { await s.close(); }
});

test('alerts: validation, triage, confirm, resolve and expiry', async () => {
  const s = await boot();
  try {
    const ok = { text: 'Gas leak smell in the stairwell', lat: 12.97, lng: 77.59, clientId: DEV, name: 'Priya' };
    assert.equal((await s.call('POST', '/api/alerts', { ...ok, text: 'hi' })).status, 400);
    assert.equal((await s.call('POST', '/api/alerts', { ...ok, lat: 51.5, lng: -0.12 })).status, 400);
    assert.equal((await s.call('POST', '/api/alerts', { ...ok, clientId: 'x' })).status, 400);
    assert.equal((await s.call('POST', '/api/alerts', { ...ok, category: 'bogus' })).status, 400);
    assert.equal((await s.call('POST', '/api/alerts', '{not json')).status, 400);

    const created = await s.call('POST', '/api/alerts', ok);
    assert.equal(created.status, 200);
    const a = created.json.alert;
    assert.equal(a.category, 'gas');
    assert.equal(a.severity, 'urgent');
    assert.equal(a.youAreAuthor, true);
    assert.equal(a.demo, false);
    assert.equal(created.json.triageSource, 'rules');
    assert.ok(!JSON.stringify(created.json).includes(DEV)); // raw device id is never returned

    // The poster can override the auto-detected values.
    const manual = await s.call('POST', '/api/alerts', { ...ok, text: 'Gas leak smell in the stairwell?', category: 'other', severity: 'info' });
    assert.equal(manual.json.alert.category, 'other');
    assert.equal(manual.json.alert.severity, 'info');

    // Confirm is idempotent per device.
    const c1 = await s.call('POST', `/api/alerts/${a.id}/confirm`, { clientId: 'device-other-0002' });
    const c2 = await s.call('POST', `/api/alerts/${a.id}/confirm`, { clientId: 'device-other-0002' });
    assert.equal(c1.json.alert.confirmCount, 1);
    assert.equal(c2.json.alert.confirmCount, 1);
    assert.equal(c2.json.alert.youConfirmed, true);

    // Non-authors need two votes to resolve; the author can resolve alone.
    const v1 = await s.call('POST', `/api/alerts/${a.id}/resolve`, { clientId: 'device-other-0002' });
    assert.equal(v1.json.alert.resolved, false);
    const v2 = await s.call('POST', `/api/alerts/${a.id}/resolve`, { clientId: 'device-third-0003' });
    assert.equal(v2.json.alert.resolved, true);
    assert.equal((await s.call('POST', `/api/alerts/${a.id}/confirm`, { clientId: DEV })).status, 404);

    const byAuthor = await s.call('POST', '/api/alerts', ok);
    const r = await s.call('POST', `/api/alerts/${byAuthor.json.alert.id}/resolve`, { clientId: DEV });
    assert.equal(r.json.alert.resolved, true);

    const listed = await s.call('GET', `/api/alerts?clientId=${DEV}`);
    assert.ok(!listed.json.alerts.some((x) => x.id === a.id));

    // Real alerts expire (info after 12 h) while samples stay.
    const before = (await s.call('GET', '/api/alerts')).json.alerts.length;
    s.advance(13 * L.HOUR);
    const after = (await s.call('GET', '/api/alerts')).json.alerts;
    assert.equal(after.length, 6);
    assert.ok(before > after.length);
  } finally { await s.close(); }
});

test('triage endpoint', async () => {
  const s = await boot();
  try {
    const r = await s.call('POST', '/api/triage', { text: 'Strong smell of gas outside the building' });
    assert.equal(r.status, 200);
    assert.equal(r.json.category, 'gas');
    assert.equal(r.json.severity, 'urgent');
    assert.equal((await s.call('POST', '/api/triage', { text: 'ab' })).status, 400);
  } finally { await s.close(); }
});

test('places: list, nearest-first, filter, add, verify', async () => {
  const s = await boot();
  try {
    const chennai = await s.call('GET', '/api/places?lat=13.04&lng=80.23&radiusKm=5');
    assert.ok(chennai.json.places.length >= 2);
    const dists = chennai.json.places.map((p) => p.distanceKm);
    assert.deepEqual([...dists].sort((a, b) => a - b), dists);

    const shelters = await s.call('GET', '/api/places?type=shelter');
    assert.ok(shelters.json.places.length >= 2 && shelters.json.places.every((p) => p.type === 'shelter'));

    assert.equal((await s.call('POST', '/api/places', { type: 'aed', name: 'x', lat: 19, lng: 72.8, clientId: DEV })).status, 400);
    assert.equal((await s.call('POST', '/api/places', { type: 'nope', name: 'Valid name', lat: 19, lng: 72.8, clientId: DEV })).status, 400);
    assert.equal((await s.call('POST', '/api/places', { type: 'aed', name: 'Valid name', lat: 40, lng: 72.8, clientId: DEV })).status, 400);

    const made = await s.call('POST', '/api/places', { type: 'aed', name: 'Temple trust AED', note: 'Ask at the front desk', lat: 19.2, lng: 72.9, clientId: DEV, addedBy: 'Sam' });
    assert.equal(made.status, 200);
    assert.equal(made.json.place.verifyCount, 1);
    assert.equal(made.json.place.addedBy, 'Sam');

    const v = await s.call('POST', `/api/places/${made.json.place.id}/verify`, { clientId: 'device-other-0002' });
    assert.equal(v.json.place.verifyCount, 2);
    const again = await s.call('POST', `/api/places/${made.json.place.id}/verify`, { clientId: 'device-other-0002' });
    assert.equal(again.json.place.verifyCount, 2);
    assert.equal((await s.call('POST', '/api/places/p_missing/verify', { clientId: DEV })).status, 404);
  } finally { await s.close(); }
});

test('circle lifecycle: create, join, miss, claim, resolve, SOS, away, settings, leave', async () => {
  const s = await boot();
  try {
    // --- create
    assert.equal((await s.call('POST', '/api/circles', { name: 'x', memberName: 'Asha' })).status, 400);
    assert.equal((await s.call('POST', '/api/circles', { name: 'Block B', memberName: 'Asha', lat: 51, lng: 0 })).status, 400);
    assert.equal((await s.call('POST', '/api/circles', { name: 'Block B', memberName: 'Asha', intervalHours: 7 })).status, 400);
    const created = await s.call('POST', '/api/circles', { name: 'Block B', area: 'Andheri', memberName: 'Asha', intervalHours: 6, graceMinutes: 30, lat: 19.12, lng: 72.85 });
    assert.equal(created.status, 200);
    const { token: tA, circle } = created.json;
    assert.match(circle.code, /^[A-Z]+-[A-Z]+-\d{4}$/);
    assert.equal(circle.members.length, 1);
    assert.equal(circle.members[0].status.state, 'ok');
    const code = circle.code;

    // --- auth
    assert.equal((await s.call('GET', `/api/circles/${code}`)).status, 401);
    assert.equal((await s.call('GET', `/api/circles/${code}`, undefined, auth('wrong-token-value-1234'))).status, 401);
    assert.equal((await s.call('GET', '/api/circles/NEEM-NEEM-0000', undefined, auth(tA))).status, 404);
    assert.equal((await s.call('GET', '/api/circles/bad', undefined, auth(tA))).status, 400);

    // --- join (code is forgiving about case and spaces)
    const joinB = await s.call('POST', '/api/circles/join', { code: code.toLowerCase().replace(/-/g, ' '), name: 'Bhavna' });
    assert.equal(joinB.status, 200);
    const tB = joinB.json.token;
    const bId = joinB.json.memberId;
    const joinC = await s.call('POST', '/api/circles/join', { code, name: 'Chandra' });
    const tC = joinC.json.token;
    assert.equal((await s.call('POST', '/api/circles/join', { code, name: '' })).status, 400);
    assert.equal((await s.call('POST', '/api/circles/join', { code: 'MANGO-TULSI-0001', name: 'Zed' })).status, 404);

    const viewA = (await s.call('GET', `/api/circles/${code}`, undefined, auth(tA))).json.circle;
    assert.equal(viewA.members.length, 3);
    assert.ok(!JSON.stringify(viewA).includes('tokenHash'));
    assert.ok(!JSON.stringify(viewA).includes(tA));
    const aId = viewA.you;

    // --- Asha misses her 6-hour check-in: ok -> due -> missed
    s.advance(6 * L.HOUR + 10 * L.MIN);
    let v = (await s.call('GET', `/api/circles/${code}`, undefined, auth(tB))).json.circle;
    assert.equal(v.members.find((m) => m.id === aId).status.state, 'due');
    // A neighbour can already offer to check in while the person is only "due"; the claim carries over.
    assert.equal((await s.call('POST', `/api/circles/${code}/members/${aId}/claim`, {}, auth(tB))).status, 200);
    s.advance(30 * L.MIN);
    v = (await s.call('GET', `/api/circles/${code}`, undefined, auth(tB))).json.circle;
    const asha = v.members.find((m) => m.id === aId);
    assert.equal(asha.status.state, 'missed');
    assert.equal(v.members[0].id, aId); // sorted to the top
    assert.equal(asha.claim.byName, 'Bhavna');

    // --- someone else cannot double-claim; the claimer can re-claim; nobody can claim a member who is fine
    const dbl = await s.call('POST', `/api/circles/${code}/members/${aId}/claim`, {}, auth(tC));
    assert.equal(dbl.status, 409);
    assert.match(dbl.json.error, /Bhavna is already checking/);
    assert.equal((await s.call('POST', `/api/circles/${code}/members/${aId}/claim`, {}, auth(tB))).status, 200);
    assert.equal((await s.call('POST', `/api/circles/${code}/members/${bId}/claim`, {}, auth(tC))).status, 409);
    assert.equal((await s.call('POST', `/api/circles/${code}/members/${aId}/claim`, {}, auth(tA))).status, 400); // not yourself

    // --- Bhavna reaches Asha and confirms she is fine
    const res = await s.call('POST', `/api/circles/${code}/members/${aId}/resolve`, {}, auth(tB));
    assert.equal(res.status, 200);
    assert.equal(res.json.circle.members.find((m) => m.id === aId).status.state, 'ok');
    assert.equal(res.json.circle.members.find((m) => m.id === aId).claim, null);
    assert.match(res.json.circle.events[0].text, /Bhavna confirmed Asha is fine/);

    // --- SOS is immediate, carries a note, and clears on check-in
    const sos = await s.call('POST', `/api/circles/${code}/sos`, { note: 'Fell in the bathroom', lat: 19.12, lng: 72.85 }, auth(tC));
    assert.equal(sos.status, 200);
    const chandra = sos.json.circle.members.find((m) => m.isYou);
    assert.equal(chandra.status.state, 'sos');
    assert.equal(chandra.sos.note, 'Fell in the bathroom');
    assert.equal(sos.json.circle.members[0].id, chandra.id);
    const asSeenByA = (await s.call('GET', `/api/circles/${code}`, undefined, auth(tA))).json.circle;
    assert.equal(asSeenByA.members.find((m) => m.id === chandra.id).sos.lat, 19.12);
    const fine = await s.call('POST', `/api/circles/${code}/checkin`, {}, auth(tC));
    assert.equal(fine.json.circle.members.find((m) => m.isYou).status.state, 'ok');

    // --- away mode
    assert.equal((await s.call('POST', `/api/circles/${code}/away`, { hours: 5 }, auth(tB))).status, 400);
    const away = await s.call('POST', `/api/circles/${code}/away`, { hours: 72 }, auth(tB));
    assert.equal(away.json.circle.members.find((m) => m.isYou).status.state, 'away');
    s.advance(60 * L.HOUR);
    assert.equal((await s.call('GET', `/api/circles/${code}`, undefined, auth(tB))).json.circle.members.find((m) => m.isYou).status.state, 'away');
    const back = await s.call('POST', `/api/circles/${code}/away`, { hours: 0 }, auth(tB));
    assert.equal(back.json.circle.members.find((m) => m.isYou).status.state, 'ok');

    // --- settings
    assert.equal((await s.call('POST', `/api/circles/${code}/settings`, { intervalHours: 5 }, auth(tA))).status, 400);
    const set = await s.call('POST', `/api/circles/${code}/settings`, { intervalHours: 12, graceMinutes: 120 }, auth(tA));
    const me = set.json.circle.members.find((m) => m.isYou);
    assert.equal(me.intervalHours, 12);
    assert.equal(me.graceMinutes, 120);

    // --- leaving; the last person out deletes the circle (privacy)
    assert.equal((await s.call('POST', `/api/circles/${code}/leave`, {}, auth(tB))).json.deleted, false);
    assert.equal((await s.call('POST', `/api/circles/${code}/leave`, {}, auth(tB))).status, 401); // already gone
    assert.equal((await s.call('POST', `/api/circles/${code}/leave`, {}, auth(tC))).json.deleted, false);
    assert.equal((await s.call('POST', `/api/circles/${code}/leave`, {}, auth(tA))).json.deleted, true);
    assert.equal((await s.call('GET', `/api/circles/${code}`, undefined, auth(tA))).status, 404);
  } finally { await s.close(); }
});

test('circle full at 12 neighbours', async () => {
  const s = await boot();
  try {
    const created = await s.call('POST', '/api/circles', { name: 'Big society', memberName: 'M0' });
    const code = created.json.circle.code;
    for (let i = 1; i < L.LIMITS.maxMembers; i += 1) {
      assert.equal((await s.call('POST', '/api/circles/join', { code, name: `M${i}` })).status, 200);
    }
    const over = await s.call('POST', '/api/circles/join', { code, name: 'One too many' });
    assert.equal(over.status, 409);
  } finally { await s.close(); }
});

test('demo circle shows one member in each state and never fills up', async () => {
  const s = await boot();
  try {
    const joined = await s.call('POST', '/api/circles/join', { code: 'demo-2026', name: 'Judge' });
    assert.equal(joined.status, 200);
    const { token, circle } = joined.json;
    assert.equal(circle.isDemo, true);
    const byName = Object.fromEntries(circle.members.map((m) => [m.name, m]));
    assert.equal(byName.Asha.status.state, 'ok');
    assert.equal(byName['Raju Uncle'].status.state, 'due');
    assert.equal(byName['Mrs. Iyer'].status.state, 'missed');
    assert.equal(byName['Mrs. Iyer'].simulated, true);
    assert.equal(circle.members[0].name, 'Mrs. Iyer');

    const claim = await s.call('POST', `/api/circles/DEMO-2026/members/${byName['Mrs. Iyer'].id}/claim`, {}, auth(token));
    assert.equal(claim.json.circle.members.find((m) => m.name === 'Mrs. Iyer').claim.byName, 'Judge');

    // A second visitor neither sees the first visitor's claim nor is blocked by it.
    const other = await s.call('POST', '/api/circles/join', { code: 'DEMO-2026', name: 'Judge Two' });
    const iyerId = byName['Mrs. Iyer'].id;
    assert.equal(other.json.circle.members.find((m) => m.id === iyerId).claim, null);
    const second = await s.call('POST', `/api/circles/DEMO-2026/members/${iyerId}/claim`, {}, auth(other.json.token));
    assert.equal(second.status, 200);
    assert.equal(second.json.circle.members.find((m) => m.id === iyerId).claim.byName, 'Judge Two');

    // "Fine" on a demo neighbour does not rewrite the scripted demo for the next visitor.
    const resolve = await s.call('POST', `/api/circles/DEMO-2026/members/${byName['Mrs. Iyer'].id}/resolve`, {}, auth(token));
    assert.match(resolve.json.demoNote, /Demo neighbour/);
    assert.equal(resolve.json.circle.members.find((m) => m.name === 'Mrs. Iyer').status.state, 'missed');

    // The demo's simulated statuses do not drift over time.
    s.advance(300 * L.HOUR);
    const later = (await s.call('GET', '/api/circles/DEMO-2026', undefined, auth(token))).json.circle;
    assert.equal(later.members.find((m) => m.name === 'Asha').status.state, 'ok');
    assert.equal(later.members.find((m) => m.name === 'Mrs. Iyer').claim, null); // demo claims fade

    // Many visitors in a row never hit the "circle is full" wall, and the demo neighbours stay.
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await s.call('POST', '/api/circles/join', { code: 'DEMO-2026', name: `V${i}` })).status, 200);
    }
    const final = (await s.call('POST', '/api/circles/join', { code: 'DEMO-2026', name: 'Last' })).json.circle;
    assert.ok(final.members.length <= L.LIMITS.maxMembers);
    assert.equal(final.members.filter((m) => m.simulated).length, 3);

    // The demo circle cannot be deleted by leaving.
    const lone = await s.call('POST', '/api/circles/join', { code: 'DEMO-2026', name: 'Solo' });
    assert.equal((await s.call('POST', '/api/circles/DEMO-2026/leave', {}, auth(lone.json.token))).json.deleted, false);
  } finally { await s.close(); }
});

test('rate limiting returns 429 with Retry-After', async () => {
  const s = await boot({ app: { rateLimit: { write: 3, read: 5, windowMs: 60000 } } });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await s.call('POST', '/api/triage', { text: 'Fire in the building' })).status, 200);
    const limited = await s.call('POST', '/api/triage', { text: 'Fire in the building' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    s.advance(61000);
    assert.equal((await s.call('POST', '/api/triage', { text: 'Fire in the building' })).status, 200);
  } finally { await s.close(); }
});

test('oversized and malformed bodies are rejected cleanly', async () => {
  const s = await boot();
  try {
    const big = await s.call('POST', '/api/triage', { text: 'x'.repeat(25 * 1024) });
    assert.equal(big.status, 413);
    assert.equal((await s.call('POST', '/api/triage', '[1,2,3]')).status, 400);
    assert.equal((await s.call('POST', '/api/triage', 'null')).status, 400);
  } finally { await s.close(); }
});

test('works with a body already parsed by the platform (Vercel style) and fake req/res', async () => {
  const store = new MemoryStore();
  const app = createApp({ store, clock: () => START });
  const headers = {};
  const res = { statusCode: 0, body: '', setHeader(k, v) { headers[k.toLowerCase()] = v; }, end(b) { this.body = b || ''; } };
  await app.handle({ method: 'POST', url: '/api/triage?x=1', headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, socket: {}, body: { text: 'Fire in the building' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).category, 'fire');
  assert.equal(headers['content-type'], 'application/json; charset=utf-8');

  const res2 = { statusCode: 0, body: '', setHeader() {}, end(b) { this.body = b || ''; } };
  await app.handle({ method: 'POST', url: '/api/triage', headers: {}, socket: {}, body: '{"text":"Strong smell of gas"}' }, res2);
  assert.equal(JSON.parse(res2.body).category, 'gas');
});

test('storage failures surface as a 500 and can recover on the next request', async () => {
  let fail = true;
  const store = new MemoryStore();
  const realGet = store.get.bind(store);
  store.get = async (k) => { if (fail) throw new Error('db down'); return realGet(k); };
  const app = createApp({ store, clock: () => START });
  const run = async () => {
    const res = { statusCode: 0, body: '', setHeader() {}, end(b) { this.body = b || ''; } };
    await app.handle({ method: 'GET', url: '/api/alerts', headers: {}, socket: {} }, res);
    return res;
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const bad = await run();
    assert.equal(bad.statusCode, 500);
    assert.ok(!bad.body.includes('db down')); // internals are not leaked
    fail = false;
    const good = await run();
    assert.equal(good.statusCode, 200);
    assert.equal(JSON.parse(good.body).alerts.length, 6);
  } finally { console.error = originalError; }
});

test('FileStore persists across instances', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padosi-'));
  const file = path.join(dir, 'db.json');
  try {
    const a = new FileStore(file);
    await a.set('k', { hello: 'world' });
    const b = new FileStore(file);
    assert.deepEqual(await b.get('k'), { hello: 'world' });
    await b.del('k');
    assert.equal(await new FileStore(file).get('k'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UpstashStore speaks the REST protocol and supports TTLs', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const args = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, args });
    if (args[0] === 'GET') return { ok: true, json: async () => ({ result: args[1] === 'padosisafe:k' ? '{"a":1}' : null }) };
    return { ok: true, json: async () => ({ result: 'OK' }) };
  };
  const store = new UpstashStore('https://example.upstash.io/', 'tok', { fetchImpl });
  assert.deepEqual(await store.get('k'), { a: 1 });
  assert.equal(await store.get('missing'), null);
  await store.set('circle:X', { b: 2 }, { ttl: 100 });
  await store.set('plain', [1]);
  await store.del('k');
  assert.equal(calls[0].url, 'https://example.upstash.io');
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.deepEqual(calls[2].args, ['SET', 'padosisafe:circle:X', '{"b":2}', 'EX', '100']);
  assert.deepEqual(calls[3].args, ['SET', 'padosisafe:plain', '[1]']);
  assert.deepEqual(calls[4].args, ['DEL', 'padosisafe:k']);

  const broken = new UpstashStore('https://x', 't', { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'nope' }) }) });
  await assert.rejects(() => broken.get('k'), /Storage error/);
});

test('store.tx serialises concurrent read-modify-write', async () => {
  const store = new MemoryStore();
  await store.set('n', 0);
  await Promise.all(Array.from({ length: 50 }, () => store.tx(async () => {
    const n = await store.get('n');
    await new Promise((r) => setImmediate(r));
    await store.set('n', n + 1);
  })));
  assert.equal(await store.get('n'), 50);
});
