'use strict';
const { v, bad, obj, HttpError, hashPassword, verifyPassword, validateScale, DEFAULT_SCALE } = require('../lib');
const { created } = require('../http');

const SCHOOL_TYPES = ['Basic School', 'JHS', 'SHS', 'Private School', 'Other'];
const DEFAULT_SUBJECTS = ['English Language', 'Mathematics', 'Integrated Science', 'Social Studies',
  'Religious & Moral Education', 'Computing', 'Creative Arts', 'Ghanaian Language', 'French', 'Physical Education'];

// "KG, Primary 1–6, JHS 1–3" -> KG, Primary 1 … Primary 6, JHS 1 … JHS 3
function parseLevels(text) {
  const out = [];
  for (const part of String(text || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.*?)\s*(\d+)\s*[–-]\s*(\d+)$/.exec(part);
    if (m && Number(m[3]) >= Number(m[2]) && Number(m[3]) - Number(m[2]) < 20) {
      for (let n = Number(m[2]); n <= Number(m[3]); n++) out.push(`${m[1]} ${n}`.trim());
    } else out.push(part);
  }
  return [...new Set(out)].map((s) => s.slice(0, 60)).slice(0, 60);
}

const slugify = (name) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'school';

module.exports = (r, { db, limiters, startSession, endSession, audit, buildMe }) => {
  let dummy;
  const dummyHash = () => (dummy ||= hashPassword('not-a-real-password'));

  r.post('/api/schools', { auth: false, maxBody: 3_000_000 }, async (ctx) => {
    limiters.register.check(ctx.ip);
    limiters.register.fail(ctx.ip);
    const a = obj(ctx.body.admin, 'admin');
    const s = obj(ctx.body.school, 'school');
    const admin = {
      name: v.str(a.name, 'Your name', { required: true, max: 100 }),
      email: v.email(a.email, 'Email'),
      phone: v.phone(a.phone, 'Phone'),
      password: v.password(a.password),
    };
    const year = v.str(s.academic_year, 'Academic year', { max: 20 }) || `${new Date().getUTCFullYear()}/${new Date().getUTCFullYear() + 1}`;
    const termCount = v.int(String(s.terms || '').match(/\d/)?.[0], 'Terms', { min: 1, max: 4 }) || 3;
    const caMax = v.int(s.ca_max, 'Class score maximum', { min: 0, max: 100 }) ?? 30;
    const school = {
      name: v.str(s.name, 'School name', { required: true, max: 120 }),
      type: v.enum(s.type, 'School type', SCHOOL_TYPES, { def: 'Basic School' }),
      location: v.str(s.location, 'Location', { max: 120 }),
      motto: v.str(s.motto, 'Motto', { max: 120 }),
      primary: v.color(s.primary, 'Primary colour', '#0f766e'),
      secondary: v.color(s.secondary, 'Secondary colour', '#f59e0b'),
      logo: v.image(s.logo, 'Logo', { max: 400_000 }),
      cover: v.image(s.cover, 'Login background', { max: 2_000_000 }),
      levels: v.str(s.levels, 'Levels', { max: 300 }),
      expected: v.int(s.expected_students, 'Number of students', { min: 1, max: 100000 }),
      scale: s.grading_scale ? validateScale(s.grading_scale) : DEFAULT_SCALE,
    };
    if (db.get('SELECT 1 x FROM users WHERE email = ?', admin.email)) throw new HttpError(409, 'An account with that email already exists');
    const hash = await hashPassword(admin.password);

    const { schoolId, userId } = db.tx(() => {
      let slug = slugify(school.name); const base = slug; let n = 1;
      while (db.get('SELECT 1 x FROM schools WHERE slug = ?', slug)) slug = `${base}-${++n}`;
      const sid = db.run(`INSERT INTO schools(slug,name,type,location,motto,phone,email,primary_color,secondary_color,logo,cover,academic_year,current_term,ca_max,exam_max,grading_scale,levels,expected_students)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
      slug, school.name, school.type, school.location, school.motto, admin.phone, admin.email, school.primary, school.secondary, school.logo, school.cover,
      year, caMax, 100 - caMax, JSON.stringify(school.scale), school.levels, school.expected).lastInsertRowid;
      const uid = db.run("INSERT INTO users(school_id,name,email,phone,role,password_hash) VALUES (?,?,?,?,'admin',?)", sid, admin.name, admin.email, admin.phone, hash).lastInsertRowid;
      for (let t = 1; t <= termCount; t++) db.run('INSERT INTO terms(school_id,academic_year,term) VALUES (?,?,?)', sid, year, t);
      for (const name of parseLevels(school.levels)) db.run('INSERT INTO classes(school_id,name) VALUES (?,?)', sid, name);
      for (const name of DEFAULT_SUBJECTS) db.run('INSERT INTO subjects(school_id,name) VALUES (?,?)', sid, name);
      return { schoolId: Number(sid), userId: Number(uid) };
    });

    const user = db.get('SELECT id, school_id, name, email, role, must_change_password FROM users WHERE id = ?', userId);
    ctx.user = user; ctx.schoolId = schoolId;
    startSession(ctx, userId);
    audit(ctx, 'school.created', 'school', schoolId, `${school.name} registered`);
    return created(buildMe(user));
  });

  r.post('/api/auth/login', { auth: false }, async (ctx) => {
    const email = v.email(ctx.body.email, 'Email');
    const password = typeof ctx.body.password === 'string' ? ctx.body.password.slice(0, 200) : '';
    const key = `${ctx.ip}|${email}`;
    limiters.login.check(key);
    const u = db.get('SELECT * FROM users WHERE email = ?', email);
    const ok = await verifyPassword(password, u ? u.password_hash : await dummyHash());
    if (!u || !ok || !u.active) { limiters.login.fail(key); throw new HttpError(401, 'Incorrect email or password'); }
    limiters.login.clear(key);
    startSession(ctx, u.id);
    ctx.user = u; ctx.schoolId = u.school_id;
    audit(ctx, 'auth.login', 'user', u.id, `${u.name} signed in`);
    return buildMe(u);
  });

  r.post('/api/auth/logout', { auth: false }, (ctx) => { endSession(ctx); });

  r.get('/api/me', (ctx) => buildMe(ctx.user));

  r.post('/api/auth/change-password', async (ctx) => {
    const key = `pw|${ctx.user.id}`;
    limiters.login.check(key);
    const current = typeof ctx.body.current_password === 'string' ? ctx.body.current_password.slice(0, 200) : '';
    const next = v.password(ctx.body.new_password, 'New password');
    const u = db.get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!(await verifyPassword(current, u.password_hash))) { limiters.login.fail(key); throw bad('Current password is incorrect'); }
    if (current === next) throw bad('Choose a password different from the current one');
    const hash = await hashPassword(next);
    db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hash, u.id);
    db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', u.id, ctx.sessionId);
    audit(ctx, 'auth.password_changed', 'user', u.id, `${u.name} changed their password`);
  });
};

module.exports.parseLevels = parseLevels;
