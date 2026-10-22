'use strict';

// Keep this string identical to the Content-Security-Policy in vercel.json (a test checks it).
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com",
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://*.tile.openstreetmap.fr https://cdn.jsdelivr.net https://unpkg.com",
  "font-src 'self'",
  "connect-src 'self' https://nominatim.openstreetmap.org",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
  'X-Frame-Options': 'DENY',
});

function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

module.exports = { CSP, SECURITY_HEADERS, applySecurityHeaders };
