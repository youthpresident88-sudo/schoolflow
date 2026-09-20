'use strict';
const { v, notFound, HttpError, today } = require('../lib');

module.exports = (r, { db, shared }) => {
  const P = { perm: 'portal:read' };

  // A parent can only ever reach students linked to their own login (404 otherwise, so ids can't be probed)
  function child(ctx, rawId) {
    const id = v.id(rawId, 'id', { required: true });
    const s = db.get(`SELECT s.id, s.admission_no, s.first_name, s.last_name, s.gender, s.dob, s.class_id, s.status, c.name AS class_name
      FROM parent_students ps JOIN students s ON s.id = ps.student_id LEFT JOIN classes c ON c.id = s.class_id
      WHERE ps.user_id = ? AND ps.student_id = ? AND ps.school_id = ?`, ctx.user.id, id, ctx.schoolId);
    if (!s) throw notFound('Student');
    return s;
  }

  r.get('/api/portal/children', P, (ctx) => {
    const kids = db.all(`SELECT s.id, s.admission_no, s.first_name, s.last_name, s.status, c.name AS class_name
      FROM parent_students ps JOIN students s ON s.id = ps.student_id LEFT JOIN classes c ON c.id = s.class_id
      WHERE ps.user_id = ? AND ps.school_id = ? ORDER BY s.first_name`, ctx.user.id, ctx.schoolId);
    const since = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    return kids.map((k) => ({ ...k, attendance: shared.attendanceSummary(ctx.schoolId, k.id, since, today()), fees: shared.studentBalance(ctx.schoolId, k.id) }));
  });

  r.get('/api/portal/children/:id', P, (ctx) => {
    const s = child(ctx, ctx.params.id);
    const period = shared.currentPeriod(ctx.schoolId);
    const dates = shared.termDates(ctx.schoolId, period.year, period.term);
    const invoices = db.all(`SELECT i.id, i.description, i.amount, i.academic_year, i.term, i.due_date,
      (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id) AS paid
      FROM invoices i WHERE i.student_id = ? AND i.school_id = ? ORDER BY i.id DESC`, s.id, ctx.schoolId).map((i) => ({ ...i, balance: i.amount - i.paid }));
    const payments = db.all('SELECT receipt_no, amount, method, received_at FROM payments WHERE student_id = ? AND school_id = ? ORDER BY id DESC LIMIT 30', s.id, ctx.schoolId);
    const reports = s.class_id ? db.all(`SELECT pr.academic_year, pr.term FROM published_reports pr WHERE pr.class_id = ? AND pr.school_id = ?
      AND EXISTS (SELECT 1 FROM results r WHERE r.student_id = ? AND r.academic_year = pr.academic_year AND r.term = pr.term)
      ORDER BY pr.academic_year DESC, pr.term DESC`, s.class_id, ctx.schoolId, s.id) : [];
    const recent = db.all('SELECT date, status FROM attendance WHERE student_id = ? AND school_id = ? ORDER BY date DESC LIMIT 14', s.id, ctx.schoolId);
    return {
      student: s, current: period,
      attendance: shared.attendanceSummary(ctx.schoolId, s.id, dates.start_date || null, dates.end_date || null),
      recent_attendance: recent, fees: { ...shared.studentBalance(ctx.schoolId, s.id), invoices, payments }, reports,
    };
  });

  r.get('/api/portal/children/:id/report', P, (ctx) => {
    const s = child(ctx, ctx.params.id);
    const cur = shared.currentPeriod(ctx.schoolId);
    const year = v.str(ctx.query.year, 'Academic year', { max: 20 }) || cur.year;
    const term = v.int(ctx.query.term, 'Term', { min: 1, max: 4 }) || cur.term;
    if (!shared.isPublished(ctx.schoolId, s.class_id, year, term)) throw new HttpError(403, 'This report card has not been released yet');
    return shared.buildReport(ctx.schoolId, s.id, year, term, { issue: true });
  });

  r.get('/api/portal/children/:id/timetable', P, (ctx) => {
    const s = child(ctx, ctx.params.id);
    if (!s.class_id) return [];
    return db.all(`SELECT t.day, t.start_time, t.end_time, t.room, sub.name AS subject, u.name AS teacher_name
      FROM timetable t LEFT JOIN subjects sub ON sub.id = t.subject_id LEFT JOIN users u ON u.id = t.teacher_id
      WHERE t.class_id = ? AND t.school_id = ? ORDER BY t.day, t.start_time`, s.class_id, ctx.schoolId);
  });

  // Announcements + upcoming events meant for this parent's children
  r.get('/api/portal/feed', P, (ctx) => {
    const classes = db.all(`SELECT DISTINCT s.class_id FROM parent_students ps JOIN students s ON s.id = ps.student_id
      WHERE ps.user_id = ? AND s.class_id IS NOT NULL`, ctx.user.id).map((x) => x.class_id);
    const marks = classes.length ? classes.map(() => '?').join(',') : 'NULL';
    const announcements = db.all(`SELECT a.id, a.title, a.body, a.created_at, c.name AS class_name, u.name AS author
      FROM announcements a LEFT JOIN classes c ON c.id = a.class_id LEFT JOIN users u ON u.id = a.created_by
      WHERE a.school_id = ? AND a.audience IN ('all','parents') AND (a.class_id IS NULL OR a.class_id IN (${marks}))
      ORDER BY a.id DESC LIMIT 30`, ctx.schoolId, ...classes);
    const events = db.all(`SELECT id, title, description, location, start_date, end_date FROM events
      WHERE school_id = ? AND audience IN ('all','parents') AND COALESCE(end_date, start_date) >= ? ORDER BY start_date LIMIT 20`, ctx.schoolId, today());
    return { announcements, events };
  });
};
