'use strict';
const { v, bad, obj, HttpError, notFound, can, paging, escapeLike, hashPassword, tempPassword } = require('../lib');
const { created } = require('../http');

const STATUSES = ['applicant', 'active', 'transferred', 'graduated', 'withdrawn'];
const GENDERS = ['male', 'female'];

module.exports = (r, { db, audit, shared, notifier }) => {
  const classBelongs = (schoolId, id) => db.get('SELECT 1 x FROM classes WHERE id = ? AND school_id = ?', id, schoolId);

  function nextAdmissionNo(schoolId) {
    const year = new Date().getUTCFullYear();
    for (;;) {
      db.run('UPDATE schools SET admission_seq = admission_seq + 1 WHERE id = ?', schoolId);
      const { admission_seq: n } = db.get('SELECT admission_seq FROM schools WHERE id = ?', schoolId);
      const no = `${year}-${String(n).padStart(4, '0')}`;
      if (!db.get('SELECT 1 x FROM students WHERE school_id = ? AND admission_no = ?', schoolId, no)) return no;
    }
  }

  function parse(body, ctx, { create }) {
    const d = {
      first_name: v.str(body.first_name, 'First name', { required: true, max: 60 }),
      last_name: v.str(body.last_name, 'Last name', { required: true, max: 60 }),
      gender: v.enum(body.gender, 'Gender', GENDERS),
      dob: v.date(body.dob, 'Date of birth', { notFuture: true }),
      class_id: v.id(body.class_id, 'Class'),
      status: v.enum(body.status, 'Status', STATUSES, { def: create ? 'active' : null }),
      address: v.str(body.address, 'Address', { max: 200 }),
      previous_school: v.str(body.previous_school, 'Previous school', { max: 120 }),
      admission_no: v.str(body.admission_no, 'Admission number', { max: 30 }),
    };
    if (d.class_id && !classBelongs(ctx.schoolId, d.class_id)) throw bad('Unknown class');
    if (body.guardians !== undefined) {
      if (!Array.isArray(body.guardians) || body.guardians.length > 4) throw bad('A student can have up to 4 guardians');
      d.guardians = body.guardians.map((g, i) => {
        g = obj(g, `Guardian ${i + 1}`);
        return {
          name: v.str(g.name, 'Guardian name', { required: true, max: 100 }),
          relationship: v.str(g.relationship, 'Relationship', { max: 40 }),
          phone: v.phone(g.phone, 'Guardian phone'),
          email: v.email(g.email, 'Guardian email', { required: false }),
          is_primary: g.is_primary ? 1 : 0,
        };
      });
      if (d.guardians.length && !d.guardians.some((g) => g.is_primary)) d.guardians[0].is_primary = 1;
    }
    return d;
  }

  function saveGuardians(schoolId, studentId, list) {
    db.run('DELETE FROM guardians WHERE student_id = ? AND school_id = ?', studentId, schoolId);
    for (const g of list) {
      db.run('INSERT INTO guardians(school_id,student_id,name,relationship,phone,email,is_primary) VALUES (?,?,?,?,?,?,?)',
        schoolId, studentId, g.name, g.relationship, g.phone, g.email, g.is_primary);
    }
  }

  function detail(schoolId, id, role) {
    const s = db.get(`SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.id = ? AND s.school_id = ?`, id, schoolId);
    if (!s) throw notFound('Student');
    s.guardians = db.all('SELECT id, name, relationship, phone, email, is_primary FROM guardians WHERE student_id = ? AND school_id = ? ORDER BY is_primary DESC, id', id, schoolId);
    s.attendance = shared.attendanceSummary(schoolId, id);
    if (can(role, 'fees:read')) {
      const invoices = db.all(`SELECT i.id, i.description, i.amount, i.academic_year, i.term, i.due_date,
        COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid
        FROM invoices i WHERE i.student_id = ? AND i.school_id = ? ORDER BY i.id DESC`, id, schoolId);
      s.invoices = invoices.map((i) => ({ ...i, balance: i.amount - i.paid }));
      s.fees = shared.studentBalance(schoolId, id);
    }
    if (can(role, 'staff:write')) {
      s.portal_users = db.all(`SELECT u.id, u.name, u.email, u.phone, u.active FROM parent_students ps JOIN users u ON u.id = ps.user_id
        WHERE ps.student_id = ? AND ps.school_id = ?`, id, schoolId);
    }
    return s;
  }

  r.get('/api/students', { perm: 'students:read' }, (ctx) => {
    const { q, class_id: classId, status } = ctx.query;
    const { page, limit, offset } = paging(ctx.query);
    const where = ['s.school_id = ?']; const p = [ctx.schoolId];
    if (q) {
      const like = `%${escapeLike(String(q).slice(0, 60))}%`;
      where.push("(s.first_name LIKE ? ESCAPE '\\' OR s.last_name LIKE ? ESCAPE '\\' OR s.admission_no LIKE ? ESCAPE '\\' OR (s.first_name || ' ' || s.last_name) LIKE ? ESCAPE '\\')");
      p.push(like, like, like, like);
    }
    if (classId === 'none') where.push('s.class_id IS NULL');
    else if (classId) { where.push('s.class_id = ?'); p.push(v.id(classId, 'Class')); }
    if (status) { where.push('s.status = ?'); p.push(v.enum(status, 'Status', STATUSES)); }
    const W = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM students s WHERE ${W}`, ...p).n;
    const items = db.all(`SELECT s.id, s.admission_no, s.first_name, s.last_name, s.gender, s.status, s.class_id, c.name AS class_name,
      (SELECT g.name FROM guardians g WHERE g.student_id = s.id ORDER BY g.is_primary DESC, g.id LIMIT 1) AS guardian_name,
      (SELECT g.phone FROM guardians g WHERE g.student_id = s.id ORDER BY g.is_primary DESC, g.id LIMIT 1) AS guardian_phone,
      COALESCE((SELECT SUM(i.amount) FROM invoices i WHERE i.student_id = s.id), 0) - COALESCE((SELECT SUM(pm.amount) FROM payments pm WHERE pm.student_id = s.id), 0) AS balance
      FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE ${W}
      ORDER BY s.first_name COLLATE NOCASE, s.last_name COLLATE NOCASE, s.id LIMIT ? OFFSET ?`, ...p, limit, offset);
    if (!can(ctx.user.role, 'fees:read')) items.forEach((i) => delete i.balance); // teachers don't see money
    return { items, total, page, limit };
  });

  r.post('/api/students', { perm: 'students:write' }, (ctx) => {
    const d = parse(ctx.body, ctx, { create: true });
    const id = db.tx(() => {
      let no = d.admission_no;
      if (no && db.get('SELECT 1 x FROM students WHERE school_id = ? AND admission_no = ?', ctx.schoolId, no)) throw new HttpError(409, 'Admission number already in use');
      const applicant = d.status === 'applicant';
      if (!no) no = applicant ? `APP-${Date.now().toString(36).toUpperCase()}` : nextAdmissionNo(ctx.schoolId);
      const sid = db.run(`INSERT INTO students(school_id,admission_no,first_name,last_name,gender,dob,class_id,status,address,previous_school,admitted_on)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ctx.schoolId, no, d.first_name, d.last_name, d.gender, d.dob, d.class_id, d.status, d.address, d.previous_school,
      applicant ? null : new Date().toISOString().slice(0, 10)).lastInsertRowid;
      saveGuardians(ctx.schoolId, Number(sid), d.guardians || []);
      return Number(sid);
    });
    audit(ctx, 'student.created', 'student', id, `Added student ${d.first_name} ${d.last_name}`);
    return created(detail(ctx.schoolId, id, ctx.user.role));
  });

  r.get('/api/students/:id', { perm: 'students:read' }, (ctx) => detail(ctx.schoolId, v.id(ctx.params.id, 'id', { required: true }), ctx.user.role));

  r.put('/api/students/:id', { perm: 'students:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    const cur = db.get('SELECT * FROM students WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    if (!cur) throw notFound('Student');
    const d = parse(ctx.body, ctx, { create: false });
    db.tx(() => {
      const no = d.admission_no || cur.admission_no;
      if (no !== cur.admission_no && db.get('SELECT 1 x FROM students WHERE school_id = ? AND admission_no = ? AND id <> ?', ctx.schoolId, no, id)) {
        throw new HttpError(409, 'Admission number already in use');
      }
      db.run(`UPDATE students SET admission_no=?, first_name=?, last_name=?, gender=?, dob=?, class_id=?, status=?, address=?, previous_school=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND school_id=?`,
      no, d.first_name, d.last_name, d.gender, d.dob, d.class_id, d.status || cur.status, d.address, d.previous_school, id, ctx.schoolId);
      if (d.guardians) saveGuardians(ctx.schoolId, id, d.guardians);
    });
    audit(ctx, 'student.updated', 'student', id, `Updated ${d.first_name} ${d.last_name}${d.status && d.status !== cur.status ? ` (status: ${d.status})` : ''}`);
    return detail(ctx.schoolId, id, ctx.user.role);
  });

  // Move an applicant (from the public admissions form) into the school register
  r.post('/api/students/:id/admit', { perm: 'students:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    const cur = db.get('SELECT * FROM students WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    if (!cur) throw notFound('Student');
    if (cur.status !== 'applicant') throw bad('Only applicants can be admitted');
    const classId = v.id(ctx.body.class_id, 'Class', { required: true });
    if (!classBelongs(ctx.schoolId, classId)) throw bad('Unknown class');
    const no = db.tx(() => {
      const n = nextAdmissionNo(ctx.schoolId);
      db.run("UPDATE students SET admission_no=?, class_id=?, status='active', admitted_on=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",
        n, classId, new Date().toISOString().slice(0, 10), id);
      return n;
    });
    const g = db.get('SELECT name, phone, email FROM guardians WHERE student_id = ? ORDER BY is_primary DESC, id LIMIT 1', id);
    const school = db.get('SELECT name FROM schools WHERE id = ?', ctx.schoolId);
    if (g) {
      const msg = `${school.name}: ${cur.first_name} ${cur.last_name} has been admitted. Admission number ${no}. Welcome!`;
      if (g.phone) notifier.enqueue(ctx.schoolId, { channel: 'sms', to: g.phone, body: msg, related: `admit:${id}`, userId: ctx.user.id });
      if (g.email) notifier.enqueue(ctx.schoolId, { channel: 'email', to: g.email, subject: 'Admission confirmed', body: msg, related: `admit:${id}`, userId: ctx.user.id });
    }
    audit(ctx, 'student.admitted', 'student', id, `Admitted ${cur.first_name} ${cur.last_name} (${no})`);
    return detail(ctx.schoolId, id, ctx.user.role);
  });

  // End-of-year promotion: promote / repeat / graduate a whole class or selected students
  r.post('/api/promotions', { perm: 'students:write' }, (ctx) => {
    const fromId = v.id(ctx.body.from_class_id, 'From class', { required: true });
    const action = v.enum(ctx.body.action, 'Action', ['promote', 'graduate'], { required: true });
    if (!classBelongs(ctx.schoolId, fromId)) throw bad('Unknown class');
    let toId = null;
    if (action === 'promote') {
      toId = v.id(ctx.body.to_class_id, 'To class', { required: true });
      if (!classBelongs(ctx.schoolId, toId)) throw bad('Unknown destination class');
      if (toId === fromId) throw bad('Choose a different destination class');
    }
    let ids = db.all("SELECT id FROM students WHERE school_id = ? AND class_id = ? AND status = 'active'", ctx.schoolId, fromId).map((x) => x.id);
    if (Array.isArray(ctx.body.student_ids)) { // subset = the rest repeat the year
      const want = new Set(ctx.body.student_ids.map((x) => v.id(x, 'Student', { required: true })));
      ids = ids.filter((x) => want.has(x));
    }
    if (!ids.length) throw bad('No students to move');
    db.tx(() => {
      for (const id of ids) {
        if (action === 'graduate') db.run("UPDATE students SET status='graduated', class_id=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND school_id=?", id, ctx.schoolId);
        else db.run("UPDATE students SET class_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND school_id=?", toId, id, ctx.schoolId);
      }
    });
    audit(ctx, 'students.promoted', 'class', fromId, `${action === 'graduate' ? 'Graduated' : 'Promoted'} ${ids.length} student(s)`);
    return { moved: ids.length };
  });

  /* ---- parent portal accounts ---- */
  r.get('/api/students/:id/portal', { perm: 'staff:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    if (!db.get('SELECT 1 x FROM students WHERE id = ? AND school_id = ?', id, ctx.schoolId)) throw notFound('Student');
    return db.all(`SELECT u.id, u.name, u.email, u.phone, u.active FROM parent_students ps JOIN users u ON u.id = ps.user_id
      WHERE ps.student_id = ? AND ps.school_id = ?`, id, ctx.schoolId);
  });

  // Creates a parent login (or links another child to an existing parent — siblings share one login)
  r.post('/api/students/:id/portal', { perm: 'staff:write' }, async (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    const st = db.get('SELECT id, first_name, last_name FROM students WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    if (!st) throw notFound('Student');
    const email = v.email(ctx.body.email, 'Parent email');
    const existing = db.get('SELECT id, school_id, role, name FROM users WHERE email = ?', email);
    let userId; let temp = null;
    if (existing) {
      if (existing.school_id !== ctx.schoolId || existing.role !== 'parent') throw new HttpError(409, 'That email is already used by another account');
      userId = existing.id;
    } else {
      temp = tempPassword();
      const hash = await hashPassword(temp);
      userId = Number(db.run("INSERT INTO users(school_id,name,email,phone,role,password_hash,must_change_password) VALUES (?,?,?,?,'parent',?,1)",
        ctx.schoolId, v.str(ctx.body.name, 'Parent name', { required: true, max: 100 }), email, v.phone(ctx.body.phone, 'Parent phone'), hash).lastInsertRowid);
    }
    db.run('INSERT OR IGNORE INTO parent_students(user_id,student_id,school_id) VALUES (?,?,?)', userId, id, ctx.schoolId);
    audit(ctx, 'portal.access_granted', 'student', id, `Parent portal access for ${st.first_name} ${st.last_name}`);
    return created({ user_id: userId, email, temporary_password: temp, linked_existing: !temp });
  });

  r.delete('/api/students/:id/portal/:userId', { perm: 'staff:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    const uid = v.id(ctx.params.userId, 'user', { required: true });
    db.run('DELETE FROM parent_students WHERE student_id = ? AND user_id = ? AND school_id = ?', id, uid, ctx.schoolId);
    audit(ctx, 'portal.access_revoked', 'student', id, 'Parent portal access removed');
  });
};
