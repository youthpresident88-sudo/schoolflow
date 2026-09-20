'use strict';
const { v, bad, obj, HttpError, parseScale, validateScale, ALL_PERMS } = require('../lib');
const { rawResponse } = require('../http');

// Spreadsheet formula-injection guard: cells starting with = + - @ get a leading apostrophe
const csvCell = (x) => {
  let s = x === null || x === undefined ? '' : String(x);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (cols, rows) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';

module.exports = (r, { db, audit }) => {
  const readSettings = (schoolId) => {
    const s = db.get('SELECT id, slug, name, type, location, motto, phone, email, primary_color, secondary_color, logo, cover, academic_year, current_term, ca_max, exam_max, grading_scale, admissions_open FROM schools WHERE id = ?', schoolId);
    s.grading_scale = parseScale(s.grading_scale);
    s.terms = db.all('SELECT term, start_date, end_date, next_term_begins FROM terms WHERE school_id = ? AND academic_year = ? ORDER BY term', schoolId, s.academic_year);
    return s;
  };

  r.get('/api/settings', { perm: 'settings:read' }, (ctx) => readSettings(ctx.schoolId));

  r.put('/api/settings', { perm: 'settings:write', maxBody: 3_000_000 }, (ctx) => {
    const b = ctx.body;
    const cur = db.get('SELECT * FROM schools WHERE id = ?', ctx.schoolId);
    const caMax = b.ca_max === undefined ? cur.ca_max : v.int(b.ca_max, 'Class score maximum', { min: 0, max: 100, required: true });
    const term = b.current_term === undefined ? cur.current_term : v.int(b.current_term, 'Current term', { min: 1, max: 4, required: true });
    const year = b.academic_year === undefined ? cur.academic_year : v.str(b.academic_year, 'Academic year', { required: true, max: 20 });
    const scale = b.grading_scale === undefined ? cur.grading_scale : JSON.stringify(validateScale(b.grading_scale));
    let logo = cur.logo; let cover = cur.cover;
    if (b.logo !== undefined) logo = b.logo === '' ? null : v.image(b.logo, 'Logo', { max: 400_000 });
    if (b.cover !== undefined) cover = b.cover === '' ? null : v.image(b.cover, 'Login background', { max: 2_000_000 });
    db.tx(() => {
      db.run(`UPDATE schools SET name=?, type=?, location=?, motto=?, phone=?, email=?, primary_color=?, secondary_color=?, logo=?, cover=?,
        academic_year=?, current_term=?, ca_max=?, exam_max=?, grading_scale=?, admissions_open=? WHERE id=?`,
      b.name === undefined ? cur.name : v.str(b.name, 'School name', { required: true, max: 120 }),
      b.type === undefined ? cur.type : v.str(b.type, 'School type', { max: 40 }),
      b.location === undefined ? cur.location : v.str(b.location, 'Location', { max: 120 }),
      b.motto === undefined ? cur.motto : v.str(b.motto, 'Motto', { max: 120 }),
      b.phone === undefined ? cur.phone : v.phone(b.phone, 'Phone'),
      b.email === undefined ? cur.email : v.email(b.email, 'Email', { required: false }),
      v.color(b.primary_color, 'Primary colour', cur.primary_color), v.color(b.secondary_color, 'Secondary colour', cur.secondary_color),
      logo, cover, year, term, caMax, 100 - caMax, scale,
      b.admissions_open === undefined ? cur.admissions_open : (b.admissions_open ? 1 : 0), ctx.schoolId);
      // make sure the current year has term rows
      const count = db.get('SELECT COUNT(*) n FROM terms WHERE school_id = ? AND academic_year = ?', ctx.schoolId, year).n;
      if (!count) for (let t = 1; t <= 3; t++) db.run('INSERT INTO terms(school_id,academic_year,term) VALUES (?,?,?)', ctx.schoolId, year, t);
    });
    audit(ctx, 'settings.updated', 'school', ctx.schoolId, 'School settings updated');
    return readSettings(ctx.schoolId);
  });

  r.put('/api/terms', { perm: 'settings:write' }, (ctx) => {
    const b = ctx.body;
    const school = db.get('SELECT academic_year FROM schools WHERE id = ?', ctx.schoolId);
    const year = v.str(b.academic_year, 'Academic year', { max: 20 }) || school.academic_year;
    const term = v.int(b.term, 'Term', { min: 1, max: 4, required: true });
    const start = v.date(b.start_date, 'Start date'); const end = v.date(b.end_date, 'End date');
    if (start && end && end < start) throw bad('End date must be after the start date');
    const next = v.date(b.next_term_begins, 'Next term begins');
    db.run(`INSERT INTO terms(school_id,academic_year,term,start_date,end_date,next_term_begins) VALUES (?,?,?,?,?,?)
      ON CONFLICT(school_id,academic_year,term) DO UPDATE SET start_date=excluded.start_date, end_date=excluded.end_date, next_term_begins=excluded.next_term_begins`,
    ctx.schoolId, year, term, start, end, next);
    audit(ctx, 'terms.updated', 'term', term, `Term ${term} ${year} dates updated`);
    return readSettings(ctx.schoolId).terms;
  });

  /* ---- data export (your data stays yours) ---- */
  const TABLES = ['classes', 'subjects', 'class_subjects', 'students', 'guardians', 'attendance', 'results', 'invoices', 'payments',
    'announcements', 'events', 'tasks', 'timetable', 'terms', 'audit_log'];
  r.get('/api/export/all', { perm: 'export:read' }, (ctx) => {
    const out = { exported_at: new Date().toISOString(), school: readSettings(ctx.schoolId) };
    delete out.school.logo; delete out.school.cover;
    for (const t of TABLES) out[t] = db.all(`SELECT * FROM ${t} WHERE school_id = ?`, ctx.schoolId);
    out.users = db.all('SELECT id, name, email, phone, role, active, created_at FROM users WHERE school_id = ?', ctx.schoolId);
    audit(ctx, 'export.all', 'school', ctx.schoolId, 'Full data export downloaded');
    return rawResponse(200, JSON.stringify(out, null, 2), {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="schoolflow-export.json"',
    });
  });

  const csv = (name, cols, sql) => r.get(`/api/export/${name}.csv`, { perm: 'export:read' }, (ctx) => {
    const rows = db.all(sql, ctx.schoolId);
    audit(ctx, 'export.csv', name, null, `${name}.csv exported (${rows.length} rows)`);
    return rawResponse(200, '\ufeff' + toCsv(cols, rows), {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`,
    });
  });
  csv('students', ['admission_no', 'first_name', 'last_name', 'gender', 'dob', 'class', 'status', 'guardian', 'guardian_phone'],
    `SELECT s.admission_no, s.first_name, s.last_name, s.gender, s.dob, c.name AS class, s.status,
       (SELECT g.name FROM guardians g WHERE g.student_id = s.id ORDER BY g.is_primary DESC, g.id LIMIT 1) AS guardian,
       (SELECT g.phone FROM guardians g WHERE g.student_id = s.id ORDER BY g.is_primary DESC, g.id LIMIT 1) AS guardian_phone
     FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.school_id = ? ORDER BY s.first_name, s.last_name`);
  csv('invoices', ['admission_no', 'student', 'description', 'academic_year', 'term', 'amount_ghs', 'paid_ghs', 'balance_ghs', 'due_date'],
    `SELECT s.admission_no, s.first_name || ' ' || s.last_name AS student, i.description, i.academic_year, i.term,
       printf('%.2f', i.amount / 100.0) AS amount_ghs,
       printf('%.2f', COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0) / 100.0) AS paid_ghs,
       printf('%.2f', (i.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0)) / 100.0) AS balance_ghs,
       i.due_date
     FROM invoices i JOIN students s ON s.id = i.student_id WHERE i.school_id = ? ORDER BY i.id`);
  csv('results', ['admission_no', 'student', 'class', 'subject', 'academic_year', 'term', 'ca_score', 'exam_score', 'total'],
    `SELECT s.admission_no, s.first_name || ' ' || s.last_name AS student, c.name AS class, sub.name AS subject,
       r.academic_year, r.term, r.ca_score, r.exam_score, r.total
     FROM results r JOIN students s ON s.id = r.student_id JOIN subjects sub ON sub.id = r.subject_id
     LEFT JOIN classes c ON c.id = s.class_id WHERE r.school_id = ? ORDER BY r.academic_year, r.term, c.name, s.first_name`);

  // lets the UI know what a role can do without hard-coding it there
  r.get('/api/meta', { auth: false }, () => ({ permissions: ALL_PERMS }));
};
