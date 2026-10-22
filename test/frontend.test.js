'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const load = () => import('../public/js/util.mjs');

test('timeAgo and formatDuration read naturally', async () => {
  const U = await load();
  assert.equal(U.timeAgo(10_000), 'just now');
  assert.equal(U.timeAgo(5 * U.MIN), '5 min ago');
  assert.equal(U.timeAgo(3 * U.HOUR), '3 h ago');
  assert.equal(U.timeAgo(3 * U.DAY), '3 days ago');
  assert.equal(U.timeAgo(-5000), 'just now');
  assert.equal(U.formatDuration(20_000), 'under a minute');
  assert.equal(U.formatDuration(45 * U.MIN), '45 min');
  assert.equal(U.formatDuration(2 * U.HOUR + 5 * U.MIN), '2 h 5 min');
  assert.equal(U.formatDuration(2 * U.HOUR), '2 h');
  assert.equal(U.formatDuration(26 * U.HOUR), '1 day 2 h');
  assert.equal(U.formatDuration(-1000), 'under a minute');
});

test('formatDistance', async () => {
  const U = await load();
  assert.equal(U.formatDistance(0.04), '40 m');
  assert.equal(U.formatDistance(0.5), '500 m');
  assert.equal(U.formatDistance(2.34), '2.3 km');
  assert.equal(U.formatDistance(48.7), '49 km');
  assert.equal(U.formatDistance(null), '');
});

test('inBounds matches the server box and rejects junk', async () => {
  const U = await load();
  const b = { south: 6.0, north: 37.8, west: 67.9, east: 98.0 };
  assert.ok(U.inBounds(19.07, 72.87, b));
  assert.ok(!U.inBounds(51.5, -0.12, b));
  assert.ok(!U.inBounds(NaN, 72, b));
  assert.equal(U.round5(19.0760123456), 19.07601);
});

test('every city chip is inside India', async () => {
  const U = await load();
  const b = { south: 6.0, north: 37.8, west: 67.9, east: 98.0 };
  assert.ok(U.CITIES.length >= 10);
  for (const c of U.CITIES) assert.ok(U.inBounds(c.lat, c.lng, b), c.name);
});

test('memberStatusView words never rely on colour alone', async () => {
  const U = await load();
  const now = 1_000_000_000;
  const ok = U.memberStatusView({ state: 'ok', lastCheckIn: now - 5 * U.MIN }, now);
  assert.equal(ok.label, 'Okay');
  assert.equal(ok.detail, 'Checked in 5 min ago');
  const missed = U.memberStatusView({ state: 'missed', lastCheckIn: now - 26 * U.HOUR }, now);
  assert.equal(missed.label, 'Missed check-in');
  assert.match(missed.detail, /26 h ago/);
  assert.equal(U.memberStatusView({ state: 'sos', since: now - U.MIN }, now).label, 'SOS');
  assert.match(U.memberStatusView({ state: 'away', until: now + 2 * U.HOUR }, now).detail, /2 h/);
  assert.match(U.memberStatusView({ state: 'due', dueAt: now - 25 * U.MIN }, now).detail, /25 min/);
});

test('option labels', async () => {
  const U = await load();
  assert.equal(U.intervalLabel(24), 'day');
  assert.equal(U.intervalLabel(48), '2 days');
  assert.equal(U.intervalLabel(6), '6 hours');
  assert.equal(U.graceLabel(30), '30 minutes');
  assert.equal(U.graceLabel(60), '1 hour');
  assert.equal(U.graceLabel(120), '2 hours');
  assert.equal(U.awayLabel(168), '1 week');
  assert.equal(U.awayLabel(24), '1 day');
  assert.equal(U.awayLabel(72), '3 days');
});

test('display metadata covers every category, place type and severity the server can send', async () => {
  const U = await load();
  const L = require('../lib/logic');
  for (const c of L.CATEGORIES) assert.ok(U.CATEGORY_META[c], `category ${c}`);
  for (const t of L.PLACE_TYPES) assert.ok(U.PLACE_META[t], `place type ${t}`);
  for (const s of L.SEVERITIES) assert.ok(U.SEVERITY_META[s], `severity ${s}`);
  assert.deepEqual(U.FALLBACK_CONFIG.intervalHours, [...L.INTERVAL_HOURS]);
  assert.deepEqual(U.FALLBACK_CONFIG.graceMinutes, [...L.GRACE_MINUTES]);
  assert.deepEqual(U.FALLBACK_CONFIG.awayHours, [...L.AWAY_HOURS]);
  assert.deepEqual(U.FALLBACK_CONFIG.bounds, { ...L.INDIA_BOUNDS });
});

test('index.html only references files that exist, and loads no inline script', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="(\/[^"#?]+)"/g)].map((m) => m[1]);
  assert.ok(refs.includes('/app.js') && refs.includes('/styles.css'));
  for (const r of refs) assert.ok(fs.existsSync(path.join(PUB, r)), `missing ${r}`);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline <script> would be blocked by the CSP');
  assert.ok(!/\son[a-z]+="/i.test(html), 'inline event handlers would be blocked by the CSP');
});

test('every relative import in the frontend resolves', () => {
  const files = [path.join(PUB, 'app.js'), ...fs.readdirSync(path.join(PUB, 'js')).map((f) => path.join(PUB, 'js', f))];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/from '(\.[^']+)'/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(f), m[1])), `${path.basename(f)} imports missing ${m[1]}`);
    }
  }
});

test('frontend never injects user text as HTML', () => {
  const files = [path.join(PUB, 'app.js'), ...fs.readdirSync(path.join(PUB, 'js')).map((f) => path.join(PUB, 'js', f))];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/\.innerHTML\s*=/.test(src), `${path.basename(f)} assigns innerHTML`);
    assert.ok(!/\binsertAdjacentHTML\b|document\.write\(/.test(src), `${path.basename(f)} writes raw HTML`);
  }
});
