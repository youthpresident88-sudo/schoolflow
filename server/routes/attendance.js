'use strict';
const { v, bad, obj, HttpError, notFound, today } = require('../lib');

const STATUSES = ['present', 'absent', 'late', 'excused'];

module.exports = (r, { db, audit, shared }) => {
  function guardClass(ctx, classId) {
    const c = db.get('SELECT id, name FROM classes WHERE id = ? AND school_id = ?', classId, ctx.schoolId);
    if (!c) throw notFound('Class');
    if (!shared.isClassTeacher(ctx.user, classId)) throw new HttpError(403, 'You can only manage attendance for your own class');
    return c;
  }

  r.get('/api/attendance', { perm: 'attendance:read' }, (ctx) => {
    const classId = v.id(ctx.query.class_id, 'Class', { required: true });
    const date = v.date(ctx.query.date || today(), 'Date');
    guardClass(ctx, classId);
    const rows = db.all(`SELECT s.id AS student_id, s.admission_no, s.first_name, s.last_name, a.status
      FROM students s LEFT JOIN attendance a ON a.student_id = s.id AND a.date = ?
      WHERE s.school_id = ? AND s.class_id = ? AND s.status = 'active'
      ORDER BY s.first_name COLLATE NOCASE, s.last_name COLLATE NOCASE`, date, ctx.schoolId, classId);
    return { class_id: classId, date, records: rows };
  });

  r.put('/api/attendance', { perm: 'attendance:write' }, (ctx) => {
    const classId = v.id(ctx.body.class_id, 'Class', { required: true });
    const date = v.date(ctx.body.date, 'Date', { required: true, notFuture: true });
    const cls = guardClass(ctx, classId);
    if (!Array.isArray(ctx.body.records) || ctx.body.records.length === 0 || ctx.body.records.length > 500) throw bad('records must list 1–500 students');
    const roster = new Set(db.all("SELECT id FROM students WHERE school_id = ? AND class_id = ? AND status = 'active'", ctx.schoolId, classId).map((x) => x.id));
    const records = ctx.body.records.map((rec) => {
      rec = obj(rec, 'record');
      const sid = v.id(rec.student_id, 'Student', { required: true });
      if (!roster.has(sid)) throw bad('A student in the list is not in this class');
      return { sid, status: v.enum(rec.status, 'Status', STATUSES, { required: true }) };
    });
    db.tx(() => {
      for (const x of records) {
        db.run(`INSERT INTO attendance(school_id,student_id,date,status,marked_by) VALUES (?,?,?,?,?)
          ON CONFLICT(student_id,date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by`,
        ctx.schoolId, x.sid, date, x.status, ctx.user.id);
      }
    });
    audit(ctx, 'attendance.marked', 'class', classId, `Attendance for ${cls.name} on ${date} (${records.length} students)`);
    return { saved: records.length };
  });

  // Per-student totals over a date range (defaults to the last 30 days)
  r.get('/api/attendance/report', { perm: 'attendance:read' }, (ctx) => {
    const classId = v.id(ctx.query.class_id, 'Class', { required: true });
    guardClass(ctx, classId);
    const to = v.date(ctx.query.to || today(), 'To');
    const from = v.date(ctx.query.from || new Date(Date.parse(to) - 29 * 86400000).toISOString().slice(0, 10), 'From');
    const rows = db.all(`SELECT s.id AS student_id, s.admission_no, s.first_name, s.last_name,
      SUM(a.status = 'present') AS present, SUM(a.status = 'late') AS late, SUM(a.status = 'absent') AS absent, SUM(a.status = 'excused') AS excused, COUNT(a.id) AS total
      FROM students s LEFT JOIN attendance a ON a.student_id = s.id AND a.date BETWEEN ? AND ?
      WHERE s.school_id = ? AND s.class_id = ? AND s.status = 'active' GROUP BY s.id ORDER BY s.first_name COLLATE NOCASE`, from, to, ctx.schoolId, classId);
    rows.forEach((x) => { x.rate = x.total ? Math.round(((x.present + x.late) / x.total) * 100) : null; });
    return { class_id: classId, from, to, students: rows };
  });
};
