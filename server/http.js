'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./lib');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(status === 204 || body === undefined ? undefined : JSON.stringify(body));
}

const created = (data) => ({ __status: 201, data });
// Non-JSON response (CSV downloads etc.)
const rawResponse = (status, body, headers = {}) => ({ __raw: { status, body, headers } });

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const chunks = [];
    req.on('data', (c) => {
      if (finished) return;
      size += c.length;
      if (size > limit) { finished = true; reject(new HttpError(413, 'Request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const j = JSON.parse(raw);
        if (!j || typeof j !== 'object' || Array.isArray(j)) return reject(new HttpError(400, 'Body must be a JSON object'));
        resolve(j);
      } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip bad cookie */ }
  }
  return out;
}

function createRouter() {
  const routes = [];
  function add(method, pattern, opts, handler) {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, opts, handler });
  }
  function match(method, pathname) {
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method) { pathMatched = true; continue; }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return { pathMatched };
  }
  return {
    match,
    get: (p, o, h) => add('GET', p, o, h),
    post: (p, o, h) => add('POST', p, o, h),
    put: (p, o, h) => add('PUT', p, o, h),
    delete: (p, o, h) => add('DELETE', p, o, h),
  };
}

// Fixed-window attempt limiter (in memory; swap for Redis when running several servers)
function createLimiter(max, windowMs) {
  const hits = new Map();
  return {
    check(key) {
      const e = hits.get(key);
      if (e && e.reset > Date.now() && e.count >= max) {
        throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
      }
    },
    fail(key) {
      const now = Date.now();
      if (hits.size > 10000) for (const [k, e] of hits) if (e.reset < now) hits.delete(k);
      let e = hits.get(key);
      if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(key, e); }
      e.count++;
    },
    clear: (key) => hits.delete(key),
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(publicDir, req, res, url) {
  const plain = (status, msg) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(msg);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method not allowed');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return plain(400, 'Bad request'); }
  if (p.endsWith('/')) p += 'index.html';
  if (p.split('/').some((seg) => seg.startsWith('.'))) return plain(404, 'Not found');
  const file = path.normalize(path.join(publicDir, p));
  if (!file.startsWith(publicDir + path.sep)) return plain(403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return plain(404, 'Not found');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

module.exports = { SECURITY_HEADERS, send, created, rawResponse, readJson, parseCookies, createRouter, createLimiter, serveStatic };
