'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

/* ---------- errors ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);

/* ---------- passwords & tokens ---------- */
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT_OPTS);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = await scrypt(pw, Buffer.from(s, 'base64'), want.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(got, want);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

function tempPassword() {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike characters
  return Array.from({ length: 12 }, () => A[crypto.randomInt(A.length)]).join('');
}

/* ---------- roles & permissions ---------- */
const STAFF_PERMS = [
  'dashboard:read', 'audit:read', 'reports:read', 'export:read',
  'students:read', 'students:write', 'classes:read', 'classes:write',
  'attendance:read', 'attendance:write',
  'results:read', 'results:write', 'results:publish',
  'fees:read', 'fees:write',
  'announcements:read', 'announcements:write',
  'timetable:read', 'timetable:write', 'events:read', 'events:write',
  'tasks:read', 'tasks:write', 'messages:use',
  'staff:read', 'staff:write', 'settings:read', 'settings:write',
];
const ALL_PERMS = [...STAFF_PERMS, 'portal:read'];
const ROLE_PERMS = {
  admin: STAFF_PERMS,
  principal: STAFF_PERMS.filter((p) => !['staff:write', 'settings:write', 'export:read'].includes(p)),
  teacher: ['dashboard:read', 'students:read', 'classes:read', 'attendance:read', 'attendance:write',
    'results:read', 'results:write', 'announcements:read', 'announcements:write', 'timetable:read', 'events:read', 'tasks:read', 'messages:use'],
  accountant: ['dashboard:read', 'reports:read', 'students:read', 'classes:read', 'fees:read', 'fees:write',
    'announcements:read', 'events:read', 'messages:use'],
  parent: ['portal:read', 'messages:use'],
};
const ROLES = Object.keys(ROLE_PERMS);
const permsFor = (role) => ROLE_PERMS[role] || [];
const can = (role, perm) => permsFor(role).includes(perm);

/* ---------- validation ---------- */
const isBlank = (x) => x === undefined || x === null || (typeof x === 'string' && x.trim() === '');
// Server date in UTC (equals Ghana time). Change here if you ever deploy for another timezone.
const today = () => new Date().toISOString().slice(0, 10);

const v = {
  str(x, name, { max = 200, min = 0, required = false } = {}) {
    if (isBlank(x)) { if (required) throw bad(`${name} is required`); return null; }
    if (typeof x !== 'string') throw bad(`${name} must be text`);
    const s = x.trim();
    if (s.length < min || s.length > max) throw bad(`${name} must be between ${min} and ${max} characters`);
    return s;
  },
  int(x, name, { min = 0, max = Number.MAX_SAFE_INTEGER, required = false } = {}) {
    if (isBlank(x)) { if (required) throw bad(`${name} is required`); return null; }
    const n = typeof x === 'string' && /^-?\d+$/.test(x.trim()) ? Number(x) : x;
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number between ${min} and ${max}`);
    return n;
  },
  id(x, name, opts = {}) { return v.int(x, name, { min: 1, ...opts }); },
  enum(x, name, list, { required = false, def = null } = {}) {
    if (isBlank(x)) { if (required) throw bad(`${name} is required`); return def; }
    if (!list.includes(x)) throw bad(`${name} must be one of: ${list.join(', ')}`);
    return x;
  },
  date(x, name, { required = false, notFuture = false } = {}) {
    if (isBlank(x)) { if (required) throw bad(`${name} is required`); return null; }
    const ok = typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x))
      && new Date(x).toISOString().slice(0, 10) === x;
    if (!ok) throw bad(`${name} must be a valid date (YYYY-MM-DD)`);
    if (notFuture && x > today()) throw bad(`${name} cannot be in the future`);
    return x;
  },
  email(x, name = 'Email', { required = true } = {}) {
    const s = v.str(x, name, { max: 254, required });
    if (s === null) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad(`${name} is not a valid email address`);
    return s.toLowerCase();
  },
  phone(x, name = 'Phone', { required = false } = {}) {
    const s = v.str(x, name, { max: 20, required });
    if (s === null) return null;
    if (!/^\+?[\d\s-]{7,18}$/.test(s)) throw bad(`${name} is not a valid phone number`);
    return s;
  },
  color(x, name, def) {
    if (isBlank(x)) return def;
    if (typeof x !== 'string' || !/^#[0-9a-f]{6}$/i.test(x)) throw bad(`${name} must be a hex colour like #0f766e`);
    return x.toLowerCase();
  },
  image(x, name, { max }) {
    if (isBlank(x)) return null;
    if (typeof x !== 'string' || x.length > max || !/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(x)) {
      throw bad(`${name} must be a PNG, JPEG, WebP or SVG image under ${Math.round(max / 1024)} KB`);
    }
    return x;
  },
  password(x, name = 'Password') {
    if (typeof x !== 'string' || x.length < 8 || x.length > 200) throw bad(`${name} must be 8–200 characters`);
    return x;
  },
};

function obj(x, name) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad(`${name} is required`);
  return x;
}

function paging(q) {
  const page = v.int(q.page, 'page', { min: 1 }) || 1;
  const limit = Math.min(100, v.int(q.limit, 'limit', { min: 1 }) || 20);
  return { page, limit, offset: (page - 1) * limit };
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => '\\' + m);

const DEFAULT_SCALE = [
  { min: 80, grade: 'A', remark: 'Excellent' },
  { min: 70, grade: 'B', remark: 'Very good' },
  { min: 60, grade: 'C', remark: 'Good' },
  { min: 50, grade: 'D', remark: 'Satisfactory' },
  { min: 40, grade: 'E', remark: 'Pass' },
  { min: 0, grade: 'F', remark: 'Needs support' },
];

function parseScale(raw) {
  try { const s = JSON.parse(raw); if (Array.isArray(s) && s.length) return s; } catch { /* use default */ }
  return DEFAULT_SCALE;
}

function validateScale(list) {
  if (!Array.isArray(list) || list.length < 2 || list.length > 12) throw bad('Grading scale needs 2–12 grades');
  const out = list.map((g, i) => ({
    min: v.int(g && g.min, `Grade ${i + 1} minimum`, { min: 0, max: 100, required: true }),
    grade: v.str(g && g.grade, `Grade ${i + 1} label`, { required: true, max: 6 }),
    remark: v.str(g && g.remark, `Grade ${i + 1} remark`, { max: 40 }) || '',
  })).sort((a, b) => b.min - a.min);
  if (out[out.length - 1].min !== 0) throw bad('The lowest grade must start at 0');
  if (new Set(out.map((g) => g.min)).size !== out.length) throw bad('Two grades cannot share the same minimum');
  return out;
}

function gradeFor(total, scale = DEFAULT_SCALE) {
  const g = scale.find((x) => total >= x.min) || scale[scale.length - 1];
  return { grade: g.grade, remark: g.remark };
}

// Competition ranking: 1, 2, 2, 4. Adds `position` to each row.
function withPositions(rows, key) {
  const sorted = [...rows].sort((a, b) => b[key] - a[key]);
  let last = null; let rank = 0;
  sorted.forEach((row, i) => { if (last === null || row[key] !== last) { rank = i + 1; last = row[key]; } row.position = rank; });
  return rows;
}

// Ghana numbers -> E.164 ("024 123 4567" -> "+233241234567"); null if not recognisable
function toE164(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  if (/^\+\d{8,15}$/.test(d)) return d;
  if (/^233\d{9}$/.test(d)) return `+${d}`;
  if (/^0\d{9}$/.test(d)) return `+233${d.slice(1)}`;
  return null;
}

module.exports = {
  HttpError, bad, notFound, hashPassword, verifyPassword, sha256, randomToken, tempPassword,
  ALL_PERMS, STAFF_PERMS, ROLES, permsFor, can, v, obj, paging, escapeLike, today,
  DEFAULT_SCALE, parseScale, validateScale, gradeFor, withPositions, toE164,
};
