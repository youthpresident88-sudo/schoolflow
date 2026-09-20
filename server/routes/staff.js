'use strict';
const { v, bad, HttpError, notFound, paging, hashPassword, tempPassword } = require('../lib');
const { created } = require('../http');

const STAFF_ROLES = ['principal', 'teacher', 'accountant'];

module.exports = (r, { db, audit }) => {
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, active: !!u.active, created_at: u.created_at });
  const staffRow = (schoolId, id) => db.get("SELECT * FROM users WHERE id = ? AND school_id = ? AND role <> 'parent'", id, schoolId);

  r.get('/api/staff', { perm: 'staff:read' }, (ctx) =>
    db.all(`SELECT u.id, u.name, u.email, u.phone, u.role, u.active, u.created_at,
      (SELECT COUNT(*) FROM classes c WHERE c.teacher_id = u.id) AS classes,
      (SELECT COUNT(*) FROM tasks t WHERE t.assigned_to = u.id AND t.status = 'open') AS open_tasks
      FROM users u WHERE u.school_id = ? AND u.role <> 'parent' ORDER BY u.role <> 'admin', u.name COLLATE NOCASE`, ctx.schoolId)
      .map((u) => ({ ...u, active: !!u.active })));

  r.post('/api/staff', { perm: 'staff:write' }, async (ctx) => {
    const d = {
      name: v.str(ctx.body.name, 'Name', { required: true, max: 100 }),
      email: v.email(ctx.body.email, 'Email'),
      phone: v.phone(ctx.body.phone, 'Phone'),
      role: v.enum(ctx.body.role, 'Role', STAFF_ROLES, { required: true }),
    };
    if (db.get('SELECT 1 x FROM users WHERE email = ?', d.email)) throw new HttpError(409, 'An account with that email already exists');
    const temp = tempPassword(); // shown once; the person must change it at first login
    const hash = await hashPassword(temp);
    const id = Number(db.run('INSERT INTO users(school_id,name,email,phone,role,password_hash,must_change_password) VALUES (?,?,?,?,?,?,1)',
      ctx.schoolId, d.name, d.email, d.phone, d.role, hash).lastInsertRowid);
    audit(ctx, 'staff.created', 'user', id, `Added ${d.role} ${d.name}`);
    return created({ staff: publicUser(staffRow(ctx.schoolId, id)), temporary_password: temp });
  });

  r.put('/api/staff/:id', { perm: 'staff:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    const cur = staffRow(ctx.schoolId, id);
    if (!cur) throw notFound('Staff member');
    if (cur.role === 'admin') {
      if (ctx.body.role !== undefined && ctx.body.role !== 'admin') throw bad("The administrator's role cannot be changed here");
      if (ctx.body.active === false) throw bad('The administrator account cannot be deactivated');
    }
    const next = {
      name: ctx.body.name === undefined ? cur.name : v.str(ctx.body.name, 'Name', { required: true, max: 100 }),
      phone: ctx.body.phone === undefined ? cur.phone : v.phone(ctx.body.phone, 'Phone'),
      role: cur.role === 'admin' ? 'admin' : (ctx.body.role === undefined ? cur.role : v.enum(ctx.body.role, 'Role', STAFF_ROLES, { required: true })),
      active: ctx.body.active === undefined ? cur.active : (ctx.body.active ? 1 : 0),
    };
    db.tx(() => {
      db.run('UPDATE users SET name=?, phone=?, role=?, active=? WHERE id=? AND school_id=?', next.name, next.phone, next.role, next.active, id, ctx.schoolId);
      if (!next.active) db.run('DELETE FROM sessions WHERE user_id = ?', id); // deactivation signs them out everywhere
    });
    audit(ctx, 'staff.updated', 'user', id, `Updated ${next.name}${next.active ? '' : ' (deactivated)'}`);
    return publicUser(staffRow(ctx.schoolId, id));
  });

  r.post('/api/staff/:id/reset-password', { perm: 'staff:write' }, async (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    const cur = staffRow(ctx.schoolId, id);
    if (!cur) throw notFound('Staff member');
    if (cur.role === 'admin') throw bad('Use "Change password" for the administrator account');
    const temp = tempPassword();
    const hash = await hashPassword(temp);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', hash, id);
      db.run('DELETE FROM sessions WHERE user_id = ?', id);
    });
    audit(ctx, 'staff.password_reset', 'user', id, `Reset password for ${cur.name}`);
    return { temporary_password: temp };
  });

  /* ---- who did what (staff activity tracking) ---- */
  r.get('/api/audit', { perm: 'audit:read' }, (ctx) => {
    const { page, limit, offset } = paging(ctx.query);
    const where = ['a.school_id = ?']; const p = [ctx.schoolId];
    if (ctx.query.user_id) { where.push('a.user_id = ?'); p.push(v.id(ctx.query.user_id, 'User')); }
    if (ctx.query.q) { where.push("a.summary LIKE ? ESCAPE '\\'"); p.push(`%${String(ctx.query.q).slice(0, 50).replace(/[\\%_]/g, (m) => '\\' + m)}%`); }
    const W = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM audit_log a WHERE ${W}`, ...p).n;
    const items = db.all(`SELECT a.id, a.action, a.entity, a.entity_id, a.summary, a.created_at, u.name AS user_name, u.role AS user_role
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${W} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
    return { items, total, page, limit };
  });
};
