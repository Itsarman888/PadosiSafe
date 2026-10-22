'use strict';

/**
 * PadosiSafe HTTP API (plain Node, no framework).
 * `createApp()` returns `{ handle(req, res) }`, which works both as a local http handler and
 * as a Vercel serverless function.
 *
 * Privacy by design: no emails, no accounts. Check-in circles use a join code plus a random
 * member token that lives only in the member's browser (we store only its hash). Alerts and
 * resources are anonymous; devices are identified by a random id that we only ever store hashed.
 */

const L = require('./logic');
const { triage } = require('./ai');
const { ensureSeed } = require('./seed');
const { EMERGENCY_NUMBERS, PLAYBOOKS } = require('./playbooks');
const { applySecurityHeaders } = require('./security');

const CIRCLE_TTL_SECONDS = 60 * 24 * 3600; // circles that go quiet for 60 days disappear

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const bad = (message) => new HttpError(400, message);

function optEnum(value, list, label) {
  if (value === undefined || value === null || value === '') return null;
  if (!list.includes(value)) throw bad(`Unknown ${label}.`);
  return value;
}

function pickOption(list, value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!list.includes(n)) throw bad(`${label} must be one of: ${list.join(', ')}.`);
  return n;
}

function requireClientId(value) {
  if (typeof value !== 'string' || !L.CLIENT_ID_RE.test(value)) {
    throw bad('Missing device id. Reload the page and try again.');
  }
  return value;
}

async function readJson(req, limit = 20 * 1024) {
  const parse = (text) => {
    if (!text) return {};
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      throw bad('Request body must be valid JSON.');
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('Request body must be a JSON object.');
    return v;
  };
  // Vercel's Node runtime may already have parsed the body.
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return parse(req.body.toString('utf8'));
    if (typeof req.body === 'string') return parse(req.body);
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  return parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(payload));
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function createApp({ store, env = process.env, clock = Date.now, fetchImpl = globalThis.fetch, rateLimit = {} } = {}) {
  const limits = { windowMs: 60_000, read: 240, write: 40, ...rateLimit };
  const routes = [];
  const hits = new Map();

  let readyPromise = null;
  function ensureReady() {
    if (!readyPromise) {
      readyPromise = ensureSeed(store, clock()).catch((e) => {
        readyPromise = null;
        throw e;
      });
    }
    return readyPromise;
  }

  function route(method, pattern, handler) {
    const keys = [];
    const source = pattern.replace(/\/:([A-Za-z]+)/g, (_, k) => {
      keys.push(k);
      return '/([^/]+)';
    });
    routes.push({ method, re: new RegExp(`^${source}/?$`), keys, handler });
  }

  function retryAfter(ip, isWrite, now) {
    const key = `${ip}:${isWrite ? 'w' : 'r'}`;
    let h = hits.get(key);
    if (!h || now >= h.resetAt) {
      h = { count: 0, resetAt: now + limits.windowMs };
      hits.set(key, h);
    }
    h.count += 1;
    if (hits.size > 5000) for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
    return h.count > (isWrite ? limits.write : limits.read) ? Math.ceil((h.resetAt - now) / 1000) : 0;
  }

  // ---------- circle helpers ----------

  const circleKey = (code) => `circle:${code}`;

  function validateCode(raw) {
    const code = L.normalizeCode(raw);
    if (!L.isValidCode(code)) throw bad('That code does not look right. It looks like NEEM-LOTUS-4821.');
    return code;
  }

  async function loadCircle(code) {
    const circle = await store.get(circleKey(code));
    if (!circle) throw new HttpError(404, 'No circle found with that code. Check it and try again.');
    return circle;
  }

  const saveCircle = (circle) => store.set(circleKey(circle.code), circle, { ttl: CIRCLE_TTL_SECONDS });

  function authMember(circle, req) {
    const token = req.headers['x-member-token'];
    if (typeof token !== 'string' || token.length < 10) {
      throw new HttpError(401, 'You are not signed in to this circle on this device. Join it again with the code.');
    }
    const hash = L.hashToken(token);
    const me = circle.members.find((m) => m.tokenHash && L.safeEqual(m.tokenHash, hash));
    if (!me) throw new HttpError(401, 'You are not signed in to this circle on this device. Join it again with the code.');
    return me;
  }

  function pushEvent(circle, now, type, text) {
    circle.events.push({ id: L.newId('e_'), at: now, type, text: L.cleanText(text, 160) });
    if (circle.events.length > L.LIMITS.maxEvents) circle.events.splice(0, circle.events.length - L.LIMITS.maxEvents);
  }

  function findMember(circle, id) {
    const m = circle.members.find((x) => x.id === id);
    if (!m) throw new HttpError(404, 'That neighbour is no longer in the circle.');
    return m;
  }

  function newMember(name, now, extra = {}) {
    const token = L.newToken();
    const member = {
      id: L.newId('m_'),
      name,
      tokenHash: L.hashToken(token),
      joinedAt: now,
      lastCheckIn: now,
      intervalHours: 24,
      graceMinutes: 60,
      pausedUntil: null,
      sos: null,
      claim: null,
      ...extra,
    };
    return { member, token };
  }

  /** Runs `fn` against a circle the caller belongs to, saves it and returns the fresh view. */
  async function mutateCircle(ctx, fn) {
    const code = validateCode(ctx.params.code);
    return store.tx(async () => {
      const now = clock();
      const circle = await loadCircle(code);
      const me = authMember(circle, ctx.req);
      const extra = (await fn({ circle, me, now, body: ctx.body })) || {};
      await saveCircle(circle);
      return { circle: L.circleView(circle, me.id, now), ...extra };
    });
  }

  // ---------- meta ----------

  route('GET', '/api/health', async () => ({ ok: true, store: store.kind, persistent: store.persistent, time: clock() }));

  route('GET', '/api/config', async () => ({
    bounds: L.INDIA_BOUNDS,
    categories: L.CATEGORIES,
    severities: L.SEVERITIES,
    placeTypes: L.PLACE_TYPES,
    intervalHours: L.INTERVAL_HOURS,
    graceMinutes: L.GRACE_MINUTES,
    awayHours: L.AWAY_HOURS,
    maxMembers: L.LIMITS.maxMembers,
    demoCode: L.DEMO_CODE,
    emergencyNumbers: EMERGENCY_NUMBERS,
    playbooks: PLAYBOOKS,
    aiEnabled: Boolean(env.ANTHROPIC_API_KEY),
    persistent: store.persistent,
    serverTime: clock(),
  }));

  route('POST', '/api/triage', async ({ body }) => {
    const text = L.cleanText(body.text, 280);
    if (text.length < 8) throw bad('Describe what is happening in a few words.');
    return triage(text, env, fetchImpl);
  });

  // ---------- circles ----------

  route('POST', '/api/circles', async ({ body }) => {
    const name = L.cleanText(body.name, 40);
    if (name.length < 2) throw bad('Give your circle a name (2 to 40 characters).');
    const memberName = L.cleanText(body.memberName, 30);
    if (!memberName) throw bad('Enter your name or a nickname.');
    const area = L.cleanText(body.area, 60);
    let loc = null;
    if (body.lat !== undefined && body.lat !== null && body.lng !== undefined && body.lng !== null) {
      loc = L.parseCoords(body.lat, body.lng);
      if (!loc) throw bad('That pin is outside India. Move it onto the map of India.');
    }
    const intervalHours = pickOption(L.INTERVAL_HOURS, body.intervalHours, 24, 'Check-in interval');
    const graceMinutes = pickOption(L.GRACE_MINUTES, body.graceMinutes, 60, 'Grace period');

    return store.tx(async () => {
      const now = clock();
      let code = null;
      for (let i = 0; i < 12 && !code; i += 1) {
        const candidate = L.genCircleCode();
        if (!(await store.get(circleKey(candidate)))) code = candidate;
      }
      if (!code) throw new HttpError(503, 'Could not create a circle right now. Try again.');
      const { member, token } = newMember(memberName, now, { intervalHours, graceMinutes });
      const circle = {
        code,
        name,
        area,
        lat: loc ? loc.lat : null,
        lng: loc ? loc.lng : null,
        createdAt: now,
        members: [member],
        events: [],
      };
      pushEvent(circle, now, 'join', `${memberName} started the circle`);
      await saveCircle(circle);
      return { token, memberId: member.id, circle: L.circleView(circle, member.id, now) };
    });
  });

  route('POST', '/api/circles/join', async ({ body }) => {
    const code = validateCode(body.code);
    const name = L.cleanText(body.name, 30);
    if (!name) throw bad('Enter your name or a nickname.');
    return store.tx(async () => {
      const now = clock();
      const circle = await loadCircle(code);
      if (circle.members.length >= L.LIMITS.maxMembers) {
        if (circle.code === L.DEMO_CODE) {
          const oldest = circle.members.findIndex((m) => !m.simulated);
          if (oldest >= 0) circle.members.splice(oldest, 1);
        } else {
          throw new HttpError(409, `This circle is full (${L.LIMITS.maxMembers} neighbours).`);
        }
      }
      const { member, token } = newMember(name, now);
      circle.members.push(member);
      pushEvent(circle, now, 'join', `${name} joined the circle`);
      await saveCircle(circle);
      return { token, memberId: member.id, circle: L.circleView(circle, member.id, now) };
    });
  });

  route('GET', '/api/circles/:code', async (ctx) => {
    const code = validateCode(ctx.params.code);
    const circle = await loadCircle(code);
    const me = authMember(circle, ctx.req);
    return { circle: L.circleView(circle, me.id, clock()) };
  });

  route('POST', '/api/circles/:code/checkin', (ctx) =>
    mutateCircle(ctx, ({ circle, me, now }) => {
      const before = L.memberStatus(me, now).state;
      me.lastCheckIn = now;
      me.simulated = undefined;
      me.sos = null;
      me.claim = null;
      me.pausedUntil = null;
      if (before !== 'ok') pushEvent(circle, now, 'checkin', `${me.name} checked in. All good.`);
    }));

  route('POST', '/api/circles/:code/settings', (ctx) =>
    mutateCircle(ctx, ({ me, body }) => {
      me.intervalHours = pickOption(L.INTERVAL_HOURS, body.intervalHours, me.intervalHours, 'Check-in interval');
      me.graceMinutes = pickOption(L.GRACE_MINUTES, body.graceMinutes, me.graceMinutes, 'Grace period');
    }));

  route('POST', '/api/circles/:code/away', (ctx) =>
    mutateCircle(ctx, ({ circle, me, now, body }) => {
      const hours = Number(body.hours);
      if (hours === 0) {
        me.pausedUntil = null;
        me.lastCheckIn = now;
        me.simulated = undefined;
        pushEvent(circle, now, 'away', `${me.name} is back`);
        return;
      }
      if (!L.AWAY_HOURS.includes(hours)) throw bad(`Away time must be 0 or one of: ${L.AWAY_HOURS.join(', ')} hours.`);
      me.pausedUntil = now + hours * L.HOUR;
      me.sos = null;
      pushEvent(circle, now, 'away', `${me.name} is away for ${hours >= 24 ? `${hours / 24} day${hours > 24 ? 's' : ''}` : `${hours} hours`}`);
    }));

  route('POST', '/api/circles/:code/sos', (ctx) =>
    mutateCircle(ctx, ({ circle, me, now, body }) => {
      const note = L.cleanText(body.note, 140);
      let loc = null;
      if (body.lat !== undefined && body.lat !== null && body.lng !== undefined && body.lng !== null) {
        loc = L.parseCoords(body.lat, body.lng);
      }
      me.sos = { active: true, at: now, note, lat: loc ? loc.lat : null, lng: loc ? loc.lng : null };
      me.pausedUntil = null;
      pushEvent(circle, now, 'sos', `${me.name} sent an SOS${note ? `: ${note}` : ''}`);
    }));

  route('POST', '/api/circles/:code/members/:id/claim', (ctx) =>
    mutateCircle(ctx, ({ circle, me, now }) => {
      const target = findMember(circle, ctx.params.id);
      if (target.id === me.id) throw bad('You cannot check on yourself. Use "I\'m okay" instead.');
      const state = L.memberStatus(target, now).state;
      if (!['due', 'missed', 'sos'].includes(state)) throw new HttpError(409, `${target.name} is fine right now.`);
      const existing = target.simulated ? null : L.activeClaim(target, now);
      if (existing && existing.byId !== me.id) throw new HttpError(409, `${existing.byName} is already checking on ${target.name}.`);
      target.claim = { byId: me.id, byName: me.name, at: now };
      pushEvent(circle, now, 'claim', `${me.name} is checking on ${target.name}`);
    }));

  route('POST', '/api/circles/:code/members/:id/resolve', (ctx) =>
    mutateCircle(ctx, ({ circle, me, now }) => {
      const target = findMember(circle, ctx.params.id);
      if (target.id === me.id) throw bad('Use "I\'m okay" to check in yourself.');
      if (target.simulated) {
        // Demo members keep their scripted state so every visitor sees the same walkthrough.
        pushEvent(circle, now, 'resolved', `${me.name} confirmed ${target.name} is fine (demo)`);
        return { demoNote: 'Demo neighbour: in a real circle this would reset their timer.' };
      }
      target.lastCheckIn = now;
      target.sos = null;
      target.claim = null;
      target.pausedUntil = null;
      pushEvent(circle, now, 'resolved', `${me.name} confirmed ${target.name} is fine`);
      return undefined;
    }));

  route('POST', '/api/circles/:code/leave', async (ctx) => {
    const code = validateCode(ctx.params.code);
    return store.tx(async () => {
      const now = clock();
      const circle = await loadCircle(code);
      const me = authMember(circle, ctx.req);
      circle.members = circle.members.filter((m) => m.id !== me.id);
      if (!circle.members.some((m) => !m.simulated) && circle.code !== L.DEMO_CODE) {
        await store.del(circleKey(code));
        return { ok: true, deleted: true };
      }
      pushEvent(circle, now, 'leave', `${me.name} left the circle`);
      await saveCircle(circle);
      return { ok: true, deleted: false };
    });
  });

  // ---------- public alert board ----------

  route('GET', '/api/alerts', async ({ query }) => {
    const now = clock();
    const origin = L.parseOrigin(query);
    const vh = L.viewerHash(query.clientId);
    const severity = L.SEVERITIES.includes(query.severity) ? query.severity : null;
    const all = (await store.get('alerts')) || [];
    let out = all.filter((a) => L.isAlertActive(a, now)).map((a) => L.publicAlert(a, now, { viewerHash: vh, origin }));
    if (origin && origin.radiusKm) out = out.filter((a) => a.distanceKm <= origin.radiusKm);
    if (severity) out = out.filter((a) => a.severity === severity);
    out.sort(L.compareAlerts);
    return { alerts: out.slice(0, 200), serverTime: now };
  });

  route('POST', '/api/alerts', async ({ body }) => {
    const text = L.cleanText(body.text, 280);
    if (text.length < 8) throw bad('Describe what is happening in a few words.');
    const loc = L.parseCoords(body.lat, body.lng);
    if (!loc) throw bad('Tap the map to drop a pin inside India first.');
    const clientId = requireClientId(body.clientId);
    const vh = L.viewerHash(clientId);
    const name = L.cleanText(body.name, 30) || 'Neighbour';
    const chosenCategory = optEnum(body.category, L.CATEGORIES, 'category');
    const chosenSeverity = optEnum(body.severity, L.SEVERITIES, 'severity');
    const auto = await triage(text, env, fetchImpl); // network call stays outside the transaction

    const now = clock();
    const alert = {
      id: L.newId('a_'),
      text,
      summary: auto.summary,
      category: chosenCategory || auto.category,
      severity: chosenSeverity || auto.severity,
      lat: loc.lat,
      lng: loc.lng,
      name,
      demo: false,
      createdAt: now,
      authorHash: vh,
      confirms: [],
      resolveVotes: [],
      resolved: false,
    };
    await store.tx(async () => {
      const alerts = L.pruneAlerts((await store.get('alerts')) || [], now);
      alerts.push(alert);
      await store.set('alerts', alerts);
    });
    return { alert: L.publicAlert(alert, now, { viewerHash: vh }), triageSource: auto.source };
  });

  function mutateAlert(ctx, fn) {
    const clientId = requireClientId(ctx.body.clientId);
    const vh = L.viewerHash(clientId);
    return store.tx(async () => {
      const now = clock();
      const alerts = (await store.get('alerts')) || [];
      const alert = alerts.find((a) => a.id === ctx.params.id);
      if (!alert || !L.isAlertActive(alert, now)) throw new HttpError(404, 'That alert has expired or was resolved.');
      fn(alert, vh);
      await store.set('alerts', alerts);
      return { alert: L.publicAlert(alert, now, { viewerHash: vh }) };
    });
  }

  route('POST', '/api/alerts/:id/confirm', (ctx) =>
    mutateAlert(ctx, (alert, vh) => {
      if (!alert.confirms.includes(vh)) alert.confirms.push(vh);
    }));

  route('POST', '/api/alerts/:id/resolve', (ctx) =>
    mutateAlert(ctx, (alert, vh) => {
      if (alert.authorHash && alert.authorHash === vh) alert.resolved = true;
      else if (!alert.resolveVotes.includes(vh)) alert.resolveVotes.push(vh);
      if (alert.resolveVotes.length >= 2) alert.resolved = true;
    }));

  // ---------- community resource map ----------

  route('GET', '/api/places', async ({ query }) => {
    const origin = L.parseOrigin(query);
    const vh = L.viewerHash(query.clientId);
    const type = L.PLACE_TYPES.includes(query.type) ? query.type : null;
    const all = (await store.get('places')) || [];
    let out = all.map((p) => L.publicPlace(p, { viewerHash: vh, origin }));
    if (type) out = out.filter((p) => p.type === type);
    if (origin && origin.radiusKm) out = out.filter((p) => p.distanceKm <= origin.radiusKm);
    out.sort(origin ? (a, b) => a.distanceKm - b.distanceKm : (a, b) => b.verifyCount - a.verifyCount || a.name.localeCompare(b.name));
    return { places: out.slice(0, 300) };
  });

  route('POST', '/api/places', async ({ body }) => {
    const type = optEnum(body.type, L.PLACE_TYPES, 'resource type');
    if (!type) throw bad('Choose what kind of resource this is.');
    const name = L.cleanText(body.name, 60);
    if (name.length < 2) throw bad('Give the resource a short name.');
    const loc = L.parseCoords(body.lat, body.lng);
    if (!loc) throw bad('Tap the map to drop a pin inside India first.');
    const clientId = requireClientId(body.clientId);
    const vh = L.viewerHash(clientId);
    const now = clock();
    const place = {
      id: L.newId('p_'),
      type,
      name,
      note: L.cleanText(body.note, 140),
      lat: loc.lat,
      lng: loc.lng,
      addedBy: L.cleanText(body.addedBy, 30) || 'Neighbour',
      createdAt: now,
      demo: false,
      verifies: [vh],
    };
    await store.tx(async () => {
      const places = (await store.get('places')) || [];
      const demo = places.filter((p) => p.demo);
      const real = places.filter((p) => !p.demo).sort((a, b) => b.createdAt - a.createdAt).slice(0, L.LIMITS.maxPlaces - 1);
      await store.set('places', [...demo, ...real, place]);
    });
    return { place: L.publicPlace(place, { viewerHash: vh }) };
  });

  route('POST', '/api/places/:id/verify', async (ctx) => {
    const vh = L.viewerHash(requireClientId(ctx.body.clientId));
    return store.tx(async () => {
      const places = (await store.get('places')) || [];
      const place = places.find((p) => p.id === ctx.params.id);
      if (!place) throw new HttpError(404, 'That resource was not found.');
      if (!place.verifies.includes(vh)) place.verifies.push(vh);
      await store.set('places', places);
      return { place: L.publicPlace(place, { viewerHash: vh }) };
    });
  });

  // ---------- entry point ----------

  async function handle(req, res) {
    try {
      applySecurityHeaders(res);
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      const matches = routes.filter((r) => r.re.test(pathname));
      if (!matches.length) throw new HttpError(404, 'Not found.');
      const match = matches.find((r) => r.method === req.method);
      if (!match) throw new HttpError(405, 'Method not allowed.');

      const now = clock();
      const wait = retryAfter(clientIp(req), req.method !== 'GET', now);
      if (wait) throw new HttpError(429, 'Too many requests. Please slow down and try again shortly.', { headers: { 'Retry-After': String(wait) } });

      await ensureReady();
      const m = match.re.exec(pathname);
      const params = {};
      match.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      const body = req.method === 'GET' ? {} : await readJson(req);
      const result = await match.handler({ req, params, query: Object.fromEntries(url.searchParams), body, ip: clientIp(req) });
      send(res, 200, result);
    } catch (e) {
      if (e instanceof HttpError) {
        send(res, e.status, { error: e.message }, e.extra.headers || {});
      } else {
        console.error('Unhandled error:', e);
        send(res, 500, { error: 'Something went wrong on our side. Please try again.' });
      }
    }
  }

  return { handle, store, ready: ensureReady };
}

module.exports = { createApp, HttpError };
