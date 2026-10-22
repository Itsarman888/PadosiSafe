'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/logic');
const { triageRules, triage } = require('../lib/ai');

const T0 = Date.UTC(2026, 9, 21, 5, 0, 0);

test('parseCoords accepts India and rejects everything else', () => {
  assert.deepEqual(L.parseCoords(19.076, 72.8777), { lat: 19.076, lng: 72.8777 });
  assert.deepEqual(L.parseCoords('28.6139', '77.209'), { lat: 28.6139, lng: 77.209 });
  assert.deepEqual(L.parseCoords(11.6234, 92.7265), { lat: 11.6234, lng: 92.7265 }); // Andaman
  assert.equal(L.parseCoords(51.5072, -0.1276), null); // London
  assert.equal(L.parseCoords(1.3521, 103.8198), null); // Singapore
  assert.equal(L.parseCoords('abc', 77), null);
  assert.equal(L.parseCoords(undefined, undefined), null);
  assert.equal(L.parseCoords(null, null), null);
  assert.equal(L.parseCoords('', ''), null);
});

test('haversineKm is accurate for known city pairs', () => {
  const d = L.haversineKm(19.076, 72.8777, 28.6139, 77.209); // Mumbai -> Delhi
  assert.ok(d > 1135 && d < 1165, `got ${d}`);
  assert.equal(Math.round(L.haversineKm(12.9716, 77.5946, 12.9716, 77.5946)), 0);
});

test('parseOrigin reads optional radius', () => {
  assert.equal(L.parseOrigin({}), null);
  assert.deepEqual(L.parseOrigin({ lat: '19.1', lng: '72.8', radiusKm: '5' }), { lat: 19.1, lng: 72.8, radiusKm: 5 });
  assert.equal(L.parseOrigin({ lat: '19.1', lng: '72.8' }).radiusKm, null);
  assert.equal(L.parseOrigin({ lat: '19.1', lng: '72.8', radiusKm: '999999' }).radiusKm, 3000);
});

test('cleanText strips control characters, collapses space and caps length', () => {
  assert.equal(L.cleanText('  hello\u0000   world \u0007 ', 50), 'hello world');
  assert.equal(L.cleanText('a'.repeat(100), 10), 'a'.repeat(10));
  assert.equal(L.cleanText(42, 10), '');
  assert.equal(L.cleanText('😀😀😀😀', 2), '😀😀'); // counts characters, not UTF-16 units
  assert.equal(L.cleanText('a\n\n\n\n\nb', 20), 'a\n\nb');
});

test('circle codes are generated, normalised and validated', () => {
  for (let i = 0; i < 50; i += 1) assert.ok(L.isValidCode(L.genCircleCode()));
  assert.equal(L.normalizeCode(' neem lotus 4821 '), 'NEEM-LOTUS-4821');
  assert.equal(L.normalizeCode('demo-2026'), 'DEMO-2026');
  assert.ok(L.isValidCode('DEMO-2026'));
  assert.ok(!L.isValidCode('hello'));
  assert.ok(!L.isValidCode('NEEM-12'));
  assert.ok(!L.isValidCode("NEEM-LOTUS-4821'; DROP"));
});

test('tokens are random, hashed and compared safely', () => {
  const a = L.newToken();
  const b = L.newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 30);
  assert.equal(L.hashToken(a), L.hashToken(a));
  assert.ok(L.safeEqual(L.hashToken(a), L.hashToken(a)));
  assert.ok(!L.safeEqual(L.hashToken(a), L.hashToken(b)));
  assert.ok(!L.safeEqual('abc', 'abcd'));
});

test('viewerHash only hashes well-formed device ids', () => {
  assert.equal(L.viewerHash('short'), null);
  assert.equal(L.viewerHash(undefined), null);
  const h = L.viewerHash('device-abc-12345678');
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.notEqual(h, 'device-abc-12345678');
});

const member = (over = {}) => ({
  id: 'm_1', name: 'A', lastCheckIn: T0, intervalHours: 24, graceMinutes: 60, pausedUntil: null, sos: null, claim: null, ...over,
});

test('memberStatus moves ok -> due -> missed on schedule', () => {
  const m = member();
  assert.equal(L.memberStatus(m, T0 + 23 * L.HOUR).state, 'ok');
  assert.equal(L.memberStatus(m, T0 + 24 * L.HOUR + 1).state, 'due');
  assert.equal(L.memberStatus(m, T0 + 24 * L.HOUR + 59 * L.MIN).state, 'due');
  assert.equal(L.memberStatus(m, T0 + 24 * L.HOUR + 60 * L.MIN).state, 'missed');
  const s = L.memberStatus(m, T0);
  assert.equal(s.dueAt, T0 + 24 * L.HOUR);
  assert.equal(s.missAt, T0 + 25 * L.HOUR);
});

test('SOS overrides everything, away mode pauses and then gives a fresh window', () => {
  const sos = member({ sos: { active: true, at: T0 } });
  assert.equal(L.memberStatus(sos, T0 + 100 * L.HOUR).state, 'sos');

  const away = member({ pausedUntil: T0 + 72 * L.HOUR });
  assert.equal(L.memberStatus(away, T0 + 50 * L.HOUR).state, 'away');
  // Back from away: they are due immediately, with the normal grace window before anyone is alerted.
  assert.equal(L.memberStatus(away, T0 + 72 * L.HOUR + 10 * L.MIN).state, 'due');
  assert.equal(L.memberStatus(away, T0 + 72 * L.HOUR + 61 * L.MIN).state, 'missed');
});

test('simulated demo members are computed from the clock', () => {
  const m = member({ simulated: { agoMin: 24 * 60 + 150 } });
  assert.equal(L.memberStatus(m, T0).state, 'missed');
  assert.equal(L.memberStatus(m, T0 + 10 * L.HOUR).state, 'missed');
  const ok = member({ simulated: { agoMin: 120 } });
  assert.equal(L.memberStatus(ok, T0 + 500 * L.HOUR).state, 'ok');
});

test('circleView sorts people who need help first and never leaks token hashes', () => {
  const circle = {
    code: 'NEEM-LOTUS-4821', name: 'Test', createdAt: T0, events: [],
    members: [
      member({ id: 'ok', name: 'Fine', tokenHash: 'SECRETHASH1' }),
      member({ id: 'late', name: 'Late', tokenHash: 'SECRETHASH2', lastCheckIn: T0 - 30 * L.HOUR }),
      member({ id: 'sos', name: 'Help', tokenHash: 'SECRETHASH3', sos: { active: true, at: T0, note: 'fell' } }),
    ],
  };
  const view = L.circleView(circle, 'ok', T0);
  assert.deepEqual(view.members.map((m) => m.id), ['sos', 'late', 'ok']);
  assert.equal(view.members.find((m) => m.id === 'ok').isYou, true);
  assert.equal(view.members[0].sos.note, 'fell');
  assert.ok(!JSON.stringify(view).includes('SECRETHASH'));
});

test('alert expiry and pruning', () => {
  const base = { demo: false, resolved: false, confirms: [], resolveVotes: [], text: 't', lat: 1, lng: 1 };
  const info = { ...base, id: '1', severity: 'info', createdAt: T0 };
  const urgent = { ...base, id: '2', severity: 'urgent', createdAt: T0 };
  assert.ok(L.isAlertActive(info, T0 + 11 * L.HOUR));
  assert.ok(!L.isAlertActive(info, T0 + 13 * L.HOUR));
  assert.ok(L.isAlertActive(urgent, T0 + 23 * L.HOUR));
  assert.ok(!L.isAlertActive({ ...urgent, resolved: true }, T0));
  const demo = { ...base, id: 'd', demo: true, ageMin: 10, severity: 'watch', createdAt: 0 };
  assert.ok(L.isAlertActive(demo, T0 + 9999 * L.HOUR));
  assert.equal(L.alertCreatedAt(demo, T0), T0 - 10 * L.MIN);
  const pruned = L.pruneAlerts([info, urgent, demo], T0 + 20 * L.HOUR);
  assert.deepEqual(pruned.map((a) => a.id).sort(), ['2', 'd']);
});

test('triage rules understand English, Hinglish and Devanagari', () => {
  const cases = [
    ['Fire in the building, people trapped on the 3rd floor', 'fire', 'urgent'],
    ['Strong smell of gas near the lift', 'gas', 'urgent'],
    ['LPG cylinder leaking in the lane', 'gas', 'urgent'],
    ['Waterlogging in the lane, knee-deep', 'flood', 'watch'],
    ['Minor waterlogging near the gate', 'flood', 'info'],
    ['Power cut since morning', 'power', 'info'],
    ['bijli nahi hai 3 ghante se', 'power', 'info'],
    ['paani nahi aa raha subah se', 'water', 'info'],
    ['बाढ़ जैसा पानी भर गया है', 'flood', 'watch'],
    ['घर में आग लग गई', 'fire', 'urgent'],
    ['Someone fainted at the park, elderly man', 'medical', 'urgent'],
    ['Suspicious person trying to break in', 'crime', 'watch'],
    ['Two bikes had an accident at the crossing', 'accident', 'watch'],
    ['Tree fell across the road after the storm', 'weather', 'watch'],
    ['Lost my umbrella somewhere around here', 'other', 'info'],
  ];
  for (const [text, category, severity] of cases) {
    const r = triageRules(text);
    assert.equal(r.category, category, `${text} -> ${r.category}`);
    assert.equal(r.severity, severity, `${text} -> ${r.severity}`);
    assert.equal(r.source, 'rules');
    assert.ok(r.summary.length > 0 && r.summary.length <= 100);
  }
});

test('triage summary trims long text on a word boundary', () => {
  const r = triageRules('Water is coming into the ground floor from the blocked drain and it keeps rising every ten minutes so everyone should move vehicles');
  assert.ok(r.summary.endsWith('…'));
  assert.ok(r.summary.length <= 91);
});

const jsonFetch = (payload, ok = true) => async () => ({ ok, json: async () => payload });
const aiReply = (text) => ({ content: [{ type: 'text', text }] });

test('LLM triage is used when it returns valid JSON', async () => {
  const f = jsonFetch(aiReply('{"category":"gas","severity":"urgent","summary":"Gas smell in stairwell"}'));
  const r = await triage('smells weird in stairwell', { ANTHROPIC_API_KEY: 'k' }, f);
  assert.deepEqual(r, { category: 'gas', severity: 'urgent', summary: 'Gas smell in stairwell', source: 'ai' });
});

test('LLM triage falls back to rules on bad output, errors or no key', async () => {
  const text = 'Fire in the building';
  const env = { ANTHROPIC_API_KEY: 'k' };
  for (const f of [
    jsonFetch(aiReply('{"category":"nonsense","severity":"urgent","summary":"x"}')),
    jsonFetch(aiReply('not json at all')),
    jsonFetch({}, false),
    async () => { throw new Error('network down'); },
  ]) {
    const r = await triage(text, env, f);
    assert.equal(r.source, 'rules');
    assert.equal(r.category, 'fire');
  }
  let called = false;
  const r = await triage(text, {}, async () => { called = true; });
  assert.equal(r.source, 'rules');
  assert.equal(called, false);
});
