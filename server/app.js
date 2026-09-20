'use strict';
const http = require('node:http');
const path = require('node:path');
const { HttpError, sha256, randomToken, can, permsFor, today } = require('./lib');
const H = require('./http');
const { createNotifier } = require('./notifier');
const makeShared = require('./shared');

const COOKIE = 'sf_session';
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const ROUTE_MODULES = [
  'auth', 'settings', 'students', 'academics', 'attendance', 'results', 'fees',
  'comms', 'staff', 'timetable', 'portal', 'public', 'dashboard',
];

function createApp(db, config = {}) {
  const publicDir = config.publicDir || path.join(__dirname, '..', 'public');
  const router = H.createRouter();
  const notifier = createNotifier(db, config, config.logger || console);
  const limiters = {
    login: H.createLimiter(8, 15 * 60_000),
    register: H.createLimiter(config.registerLimit || 10, 3600_000),
    apply: H.createLimiter(config.applyLimit || 8, 3600_000),
    verify: H.createLimiter(30, 3600_000),
  };

  const clientIp = (req) => {
    if (config.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  };
  const cookieFlags = (req) => 'Path=/; HttpOnly; SameSite=Lax' +
    (config.secureCookies || req.socket.encrypted || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '');

  const svc = {
    db, config, limiters, notifier, shared: makeShared(db),

    startSession(ctx, userId) {
      const token = randomToken();
      db.run('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)', sha256(token), userId, Date.now() + SESSION_MS, Date.now());
      ctx.res.setHeader('Set-Cookie', `${COOKIE}=${token}; Max-Age=${SESSION_MS / 1000}; ${cookieFlags(ctx.req)}`);
    },
    endSession(ctx) {
      const tok = H.parseCookies(ctx.req.headers.cookie)[COOKIE];
      if (tok) db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(tok));
      ctx.res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags(ctx.req)}`);
    },
    audit(ctx, action, entity, entityId, summary) {
      db.run('INSERT INTO audit_log(school_id,user_id,action,entity,entity_id,summary,ip) VALUES (?,?,?,?,?,?,?)',
        ctx.schoolId, ctx.user ? ctx.user.id : null, action, entity, entityId ?? null, summary, ctx.ip);
    },
    school(id) { return db.get('SELECT * FROM schools WHERE id = ?', id); },
    buildMe(user) {
      const s = db.get(`SELECT id, slug, name, type, location, motto, phone, email, primary_color, secondary_color, logo, cover,
        academic_year, current_term, ca_max, exam_max, admissions_open FROM schools WHERE id = ?`, user.school_id);
      return {
        user: { id: user.id, name: user.name, email: user.email, role: user.role, must_change_password: !!user.must_change_password },
        school: s,
        permissions: permsFor(user.role),
      };
    },
    // Tenant for public (unauthenticated) endpoints: subdomain if SF_BASE_DOMAIN is set, else ?school=slug
    slugFrom(ctx) {
      const host = String(ctx.req.headers.host || '').split(':')[0].toLowerCase();
      if (config.baseDomain && host.endsWith('.' + config.baseDomain)) return host.slice(0, -(config.baseDomain.length + 1));
      return String(ctx.query.school || '').toLowerCase();
    },
  };

  function csrf(req) {
    const origin = req.headers.origin;
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Bad origin'); }
      if (host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
    }
    if (req.method !== 'DELETE' && !/^application\/json/i.test(req.headers['content-type'] || '')) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
  }

  function authenticate(ctx) {
    const tok = H.parseCookies(ctx.req.headers.cookie)[COOKIE];
    if (!tok) throw new HttpError(401, 'Please sign in');
    const row = db.get(`SELECT s.id AS sid, s.expires_at, u.id, u.school_id, u.name, u.email, u.role, u.active, u.must_change_password
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, sha256(tok));
    if (!row || !row.active || row.expires_at < Date.now()) {
      if (row) db.run('DELETE FROM sessions WHERE id = ?', row.sid);
      throw new HttpError(401, 'Your session has expired. Please sign in again');
    }
    ctx.user = { id: row.id, school_id: row.school_id, name: row.name, email: row.email, role: row.role, must_change_password: row.must_change_password };
    ctx.schoolId = row.school_id;
    ctx.sessionId = row.sid;
  }

  function errorResponse(res, e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return H.send(res, e.status, { error: { message: e.message } });
    if (e && e.code === 'ERR_SQLITE_ERROR') {
      if (/UNIQUE constraint failed/.test(e.message)) return H.send(res, 409, { error: { message: 'That record already exists' } });
      if (/FOREIGN KEY|CHECK constraint|NOT NULL/.test(e.message)) return H.send(res, 400, { error: { message: 'Some of the submitted data is not valid' } });
    }
    (config.logger || console).error(e);
    return H.send(res, 500, { error: { message: 'Something went wrong on our side' } });
  }

  async function handleApi(req, res, url) {
    try {
      let m;
      try { m = router.match(req.method, url.pathname); } catch { throw new HttpError(400, 'Bad request'); }
      if (!m.route) throw new HttpError(m.pathMatched ? 405 : 404, m.pathMatched ? 'Method not allowed' : 'Not found');
      const { route, params } = m;
      const ctx = { req, res, url, params, query: Object.fromEntries(url.searchParams), ip: clientIp(req), schoolId: null, user: null };
      if (MUTATING.has(req.method)) csrf(req);
      if (route.opts.auth !== false) {
        authenticate(ctx);
        if (route.opts.perm && !can(ctx.user.role, route.opts.perm)) throw new HttpError(403, 'You do not have permission to do this');
      }
      ctx.body = MUTATING.has(req.method) ? await H.readJson(req, route.opts.maxBody || 1_000_000) : {};
      const out = await route.handler(ctx);
      if (out && out.__raw) {
        const { status, body, headers } = out.__raw;
        res.writeHead(status, { ...H.SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers });
        return res.end(body);
      }
      if (out && out.__status) return H.send(res, out.__status, out.data);
      if (out === undefined) return H.send(res, 204);
      return H.send(res, 200, out);
    } catch (e) { return errorResponse(res, e); }
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return H.serveStatic(publicDir, req, res, url);
  });

  for (const name of ROUTE_MODULES) require(`./routes/${name}`)(router, svc);

  // housekeeping: expired sessions
  db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  const sweep = setInterval(() => db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now()), 3600_000);
  sweep.unref();
  notifier.start(config.notifyIntervalMs === undefined ? 10_000 : config.notifyIntervalMs);

  server.on('close', () => { clearInterval(sweep); notifier.stop(); });
  return { server, svc };
}

module.exports = { createApp, today };
