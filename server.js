'use strict';

// Local development server: serves public/ and the /api routes. (Vercel does not use this file.)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./lib/app');
const { createStore } = require('./lib/store');
const { applySecurityHeaders } = require('./lib/security');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res) {
  applySecurityHeaders(res);
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.statusCode = 400;
    res.end('Bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(data);
  });
}

function start(port = Number(process.env.PORT) || 3000) {
  const app = createApp({ store: createStore(process.env) });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api')) app.handle(req, res);
    else serveStatic(req, res);
  });
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      console.log(`PadosiSafe running at http://localhost:${addr.port}  (storage: ${app.store.kind})`);
      resolve(server);
    });
  });
}

if (require.main === module) start();

module.exports = { start };
