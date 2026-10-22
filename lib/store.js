'use strict';

/**
 * Tiny key/value storage with three backends:
 *   - UpstashStore  – durable, used on Vercel when an Upstash Redis / Vercel KV integration is attached
 *   - FileStore     – local development (data/db.json)
 *   - MemoryStore   – tests, and Vercel without a database (works for demos, resets on cold start)
 *
 * Values are JSON. `tx(fn)` serialises read-modify-write sections within one process.
 */

const fs = require('node:fs');
const path = require('node:path');

class BaseStore {
  constructor() {
    this._chain = Promise.resolve();
  }

  tx(fn) {
    const run = this._chain.then(() => fn());
    this._chain = run.catch(() => {});
    return run;
  }
}

class MemoryStore extends BaseStore {
  constructor() {
    super();
    this.kind = 'memory';
    this.persistent = false;
    this.map = new Map();
  }

  async get(key) {
    const v = this.map.get(key);
    return v === undefined ? null : JSON.parse(v);
  }

  async set(key, value) {
    this.map.set(key, JSON.stringify(value));
  }

  async del(key) {
    this.map.delete(key);
  }
}

class FileStore extends MemoryStore {
  constructor(file) {
    super();
    this.kind = 'file';
    this.persistent = true;
    this.file = file;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(raw)) this.map.set(k, JSON.stringify(v));
    } catch {
      /* first run or unreadable file: start empty */
    }
  }

  _flush() {
    const obj = {};
    for (const [k, v] of this.map) obj[k] = JSON.parse(v);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, this.file);
  }

  async set(key, value) {
    await super.set(key, value);
    this._flush();
  }

  async del(key) {
    await super.del(key);
    this._flush();
  }
}

class UpstashStore extends BaseStore {
  constructor(url, token, { prefix = 'padosisafe:', fetchImpl = globalThis.fetch } = {}) {
    super();
    this.kind = 'upstash';
    this.persistent = true;
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.prefix = prefix;
    this.fetch = fetchImpl;
  }

  async _cmd(args) {
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(6000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`Storage error: ${data.error || res.status}`);
    return data.result;
  }

  async get(key) {
    const r = await this._cmd(['GET', this.prefix + key]);
    return r === null || r === undefined ? null : JSON.parse(r);
  }

  /** `ttl` (seconds) lets private data such as circles expire on its own. */
  async set(key, value, { ttl } = {}) {
    const args = ['SET', this.prefix + key, JSON.stringify(value)];
    if (ttl) args.push('EX', String(ttl));
    await this._cmd(args);
  }

  async del(key) {
    await this._cmd(['DEL', this.prefix + key]);
  }
}

function createStore(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashStore(url, token);
  const local = !env.VERCEL && env.PADOSI_STORE !== 'memory' && env.NODE_ENV !== 'test';
  if (local) return new FileStore(path.join(__dirname, '..', 'data', 'db.json'));
  return new MemoryStore();
}

module.exports = { createStore, MemoryStore, FileStore, UpstashStore };
