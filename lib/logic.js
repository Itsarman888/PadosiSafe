'use strict';

/**
 * Pure helpers: validation, geo maths, check-in status, public views.
 * Nothing here touches the network or storage, so it is easy to unit test.
 */

const crypto = require('node:crypto');

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

// A generous box around India (includes Andaman & Nicobar, Lakshadweep and Ladakh).
const INDIA_BOUNDS = Object.freeze({ south: 6.0, north: 37.8, west: 67.9, east: 98.0 });

const CATEGORIES = Object.freeze(['flood', 'fire', 'gas', 'power', 'medical', 'crime', 'accident', 'weather', 'water', 'other']);
const SEVERITIES = Object.freeze(['info', 'watch', 'urgent']);
const SEVERITY_RANK = Object.freeze({ info: 0, watch: 1, urgent: 2 });
const PLACE_TYPES = Object.freeze(['first_aid', 'extinguisher', 'aed', 'first_aider', 'hospital', 'pharmacy', 'shelter', 'police', 'fire_station', 'water']);

const INTERVAL_HOURS = Object.freeze([6, 12, 24, 48]);
const GRACE_MINUTES = Object.freeze([30, 60, 120, 240]);
const AWAY_HOURS = Object.freeze([6, 24, 72, 168]);
const EXPIRY_HOURS = Object.freeze({ info: 12, watch: 24, urgent: 24 });
const LIMITS = Object.freeze({ maxMembers: 12, maxEvents: 20, maxAlerts: 300, maxPlaces: 600 });

const DEMO_CODE = 'DEMO-2026';
const CODE_WORDS = Object.freeze(['NEEM', 'CHAI', 'MANGO', 'LOTUS', 'BANYAN', 'TULSI', 'PEEPAL', 'MOGRA', 'JASMINE', 'CHINAR', 'SAFFRON', 'MARIGOLD']);
const CODE_RE = /^[A-Z]{3,10}(-[A-Z]{3,10})?-\d{4}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ---------- numbers & text ----------

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** Returns {lat, lng} rounded to ~1 m, or null if missing / outside India. */
function parseCoords(lat, lng) {
  const a = toNumber(lat);
  const b = toNumber(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < INDIA_BOUNDS.south || a > INDIA_BOUNDS.north) return null;
  if (b < INDIA_BOUNDS.west || b > INDIA_BOUNDS.east) return null;
  return { lat: Math.round(a * 1e5) / 1e5, lng: Math.round(b * 1e5) / 1e5 };
}

/** Optional "near me" origin from a query string. */
function parseOrigin(query = {}) {
  const c = parseCoords(query.lat, query.lng);
  if (!c) return null;
  const r = toNumber(query.radiusKm);
  return { ...c, radiusKm: Number.isFinite(r) && r > 0 ? Math.min(r, 3000) : null };
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371.0088;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Strips control characters, collapses whitespace and caps length (in characters). */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const s = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return Array.from(s).slice(0, max).join('').trim();
}

// ---------- ids, tokens, codes ----------

function newId(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** One-way hash of an anonymous device id, so we never store the raw id. */
function viewerHash(clientId) {
  return typeof clientId === 'string' && CLIENT_ID_RE.test(clientId)
    ? hashToken(`device:${clientId}`).slice(0, 32)
    : null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function genCircleCode() {
  const pick = () => CODE_WORDS[crypto.randomInt(CODE_WORDS.length)];
  const digits = String(crypto.randomInt(10000)).padStart(4, '0');
  return `${pick()}-${pick()}-${digits}`;
}

function normalizeCode(input) {
  return String(input || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

function isValidCode(code) {
  return CODE_RE.test(code);
}

// ---------- check-in status ----------

function effectiveLastCheckIn(m, now) {
  return m.simulated ? now - m.simulated.agoMin * MIN : m.lastCheckIn;
}

/**
 * ok      – before the next check-in is due
 * due     – overdue, still inside the grace window (gentle nudge to them)
 * missed  – grace window over: circle should check on them
 * sos     – they pressed SOS
 * away    – they paused check-ins (travelling, hospital, etc.)
 */
function memberStatus(m, now) {
  const last = effectiveLastCheckIn(m, now);
  if (m.sos && m.sos.active) {
    return { state: 'sos', since: m.sos.at, lastCheckIn: last, dueAt: null, missAt: null };
  }
  if (m.pausedUntil && now < m.pausedUntil) {
    return { state: 'away', until: m.pausedUntil, lastCheckIn: last, dueAt: null, missAt: null };
  }
  let dueAt = last + m.intervalHours * HOUR;
  if (m.pausedUntil) dueAt = Math.max(dueAt, m.pausedUntil);
  const missAt = dueAt + m.graceMinutes * MIN;
  const state = now < dueAt ? 'ok' : now < missAt ? 'due' : 'missed';
  return { state, lastCheckIn: last, dueAt, missAt };
}

const STATE_RANK = Object.freeze({ sos: 0, missed: 1, due: 2, ok: 3, away: 4 });

function activeClaim(m, now) {
  if (!m.claim) return null;
  if (m.simulated && now - m.claim.at > 15 * MIN) return null; // demo claims fade quickly
  return m.claim;
}

function circleView(circle, viewerId, now) {
  const members = circle.members
    .map((m) => {
      const status = memberStatus(m, now);
      const needsHelp = status.state === 'sos' || status.state === 'missed' || status.state === 'due';
      // Sample neighbours are shared by every visitor of the demo circle, so a claim on them is
      // only shown to the person who made it. Otherwise one visitor would block the next.
      const live = needsHelp ? activeClaim(m, now) : null;
      const claim = live && (!m.simulated || live.byId === viewerId) ? live : null;
      return {
        id: m.id,
        name: m.name,
        isYou: m.id === viewerId,
        simulated: Boolean(m.simulated),
        joinedAt: m.joinedAt,
        intervalHours: m.intervalHours,
        graceMinutes: m.graceMinutes,
        status,
        claim: claim ? { byId: claim.byId, byName: claim.byName, at: claim.at } : null,
        sos: status.state === 'sos' ? { at: m.sos.at, note: m.sos.note || '', lat: m.sos.lat ?? null, lng: m.sos.lng ?? null } : null,
      };
    })
    .sort((a, b) => STATE_RANK[a.status.state] - STATE_RANK[b.status.state]);

  return {
    code: circle.code,
    name: circle.name,
    area: circle.area || '',
    lat: circle.lat ?? null,
    lng: circle.lng ?? null,
    createdAt: circle.createdAt,
    maxMembers: LIMITS.maxMembers,
    isDemo: circle.code === DEMO_CODE,
    members,
    events: circle.events.slice(-15).reverse(),
    you: viewerId,
    serverTime: now,
  };
}

// ---------- alerts ----------

function alertCreatedAt(a, now) {
  return a.demo ? now - a.ageMin * MIN : a.createdAt;
}

function alertExpiresAt(a) {
  return a.demo ? Infinity : a.createdAt + EXPIRY_HOURS[a.severity] * HOUR;
}

function isAlertActive(a, now) {
  return !a.resolved && now < alertExpiresAt(a);
}

/** Drops long-expired alerts and enforces the storage cap (oldest real alerts go first). */
function pruneAlerts(alerts, now) {
  const keep = alerts.filter((a) => a.demo || now < alertExpiresAt(a) + 6 * HOUR);
  const demo = keep.filter((a) => a.demo);
  const real = keep.filter((a) => !a.demo).sort((a, b) => b.createdAt - a.createdAt).slice(0, LIMITS.maxAlerts);
  return [...demo, ...real];
}

function publicAlert(a, now, { viewerHash: vh = null, origin = null } = {}) {
  return {
    id: a.id,
    text: a.text,
    summary: a.summary,
    category: a.category,
    severity: a.severity,
    lat: a.lat,
    lng: a.lng,
    name: a.name,
    createdAt: alertCreatedAt(a, now),
    expiresAt: a.demo ? null : alertExpiresAt(a),
    confirmCount: a.confirms.length,
    resolveVotes: a.resolveVotes.length,
    resolved: Boolean(a.resolved),
    demo: Boolean(a.demo),
    youConfirmed: Boolean(vh) && a.confirms.includes(vh),
    youAreAuthor: Boolean(vh) && a.authorHash === vh,
    distanceKm: origin ? round1(haversineKm(origin.lat, origin.lng, a.lat, a.lng)) : null,
  };
}

function compareAlerts(a, b) {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.createdAt - a.createdAt;
}

// ---------- places ----------

function publicPlace(p, { viewerHash: vh = null, origin = null } = {}) {
  return {
    id: p.id,
    type: p.type,
    name: p.name,
    note: p.note || '',
    lat: p.lat,
    lng: p.lng,
    addedBy: p.addedBy || 'Neighbour',
    createdAt: p.createdAt,
    verifyCount: p.verifies.length,
    youVerified: Boolean(vh) && p.verifies.includes(vh),
    demo: Boolean(p.demo),
    distanceKm: origin ? round1(haversineKm(origin.lat, origin.lng, p.lat, p.lng)) : null,
  };
}

module.exports = {
  HOUR, MIN, INDIA_BOUNDS, CATEGORIES, SEVERITIES, SEVERITY_RANK, PLACE_TYPES,
  INTERVAL_HOURS, GRACE_MINUTES, AWAY_HOURS, EXPIRY_HOURS, LIMITS, DEMO_CODE, CLIENT_ID_RE,
  toNumber, round1, parseCoords, parseOrigin, haversineKm, cleanText,
  newId, newToken, hashToken, viewerHash, safeEqual, genCircleCode, normalizeCode, isValidCode,
  memberStatus, circleView, activeClaim,
  alertCreatedAt, alertExpiresAt, isAlertActive, pruneAlerts, publicAlert, compareAlerts,
  publicPlace,
};
