'use strict';
const { can, today, parseScale, gradeFor } = require('../lib');

module.exports = (r, { db, shared }) => {
  const PAID = '(SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id)';
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  r.get('/api/dashboard', { perm: 'dashboard:read' }, (ctx) => {
    const sid = ctx.schoolId; const role = ctx.user.role; const t = today();
    const period = shared.currentPeriod(sid);
    const lead = shared.leadership(ctx.user);
    const out = { role, period };

    out.students = db.get("SELECT COUNT(*) AS n FROM students WHERE school_id = ? AND status = 'active'", sid).n;
    out.applicants = db.get("SELECT COUNT(*) AS n FROM students WHERE school_id = ? AND status = 'applicant'", sid).n;
    if (can(role, 'staff:read')) out.staff = db.get("SELECT COUNT(*) AS n FROM users WHERE school_id = ? AND active = 1 AND role <> 'parent'", sid).n;

    if (can(role, 'attendance:read')) {
      const rows = db.all('SELECT status, COUNT(*) AS n FROM attendance WHERE school_id = ? AND date = ? GROUP BY status', sid, t);
      const a = { present: 0, late: 0, absent: 0, excused: 0, marked: 0, rate: null };
      for (const x of rows) { a[x.status] = x.n; a.marked += x.n; }
      if (a.marked) a.rate = Math.round(((a.present + a.late) / a.marked) * 100);
      out.attendance = a;
      out.classes_unmarked = db.get(`SELECT COUNT(*) AS n FROM classes c WHERE c.school_id = ?
        AND EXISTS (SELECT 1 FROM students s WHERE s.class_id = c.id AND s.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM attendance a JOIN students s ON s.id = a.student_id WHERE s.class_id = c.id AND a.date = ?)
        AND (? = 1 OR c.teacher_id = ?)`, sid, t, lead ? 1 : 0, ctx.user.id).n;
      const trend = db.all(`SELECT date, ROUND(100.0 * SUM(status IN ('present','late')) / COUNT(*)) AS rate FROM attendance
        WHERE school_id = ? AND date >= ? GROUP BY date`, sid, daysAgo(6));
      const byDate = new Map(trend.map((x) => [x.date, x.rate]));
      out.attendance_trend = Array.from({ length: 7 }, (_, i) => { const d = daysAgo(6 - i); return { date: d, rate: byDate.has(d) ? byDate.get(d) : null }; });
    }

    if (can(role, 'fees:read')) out.fees = shared.feeStats(sid, period.year);

    if (can(role, 'results:read')) {
      const avg = db.get('SELECT AVG(total) AS a FROM results WHERE school_id = ? AND academic_year = ? AND term = ? AND total IS NOT NULL', sid, period.year, period.term).a;
      out.academic_average = avg === null ? null : Math.round(avg * 10) / 10;
    }

    if (can(role, 'events:read')) {
      out.events = db.all(`SELECT id, title, location, start_date, end_date FROM events WHERE school_id = ? AND COALESCE(end_date, start_date) >= ?
        ORDER BY start_date LIMIT 4`, sid, t);
    }
    if (can(role, 'tasks:read')) {
      const q = db.get(`SELECT SUM(status = 'open') AS open, SUM(status = 'open' AND due_date IS NOT NULL AND due_date < ?) AS overdue
        FROM tasks WHERE school_id = ? AND (? = 1 OR assigned_to = ?)`, t, sid, lead ? 1 : 0, ctx.user.id);
      out.tasks = { open: q.open || 0, overdue: q.overdue || 0, scope: lead ? 'school' : 'mine' };
    }
    if (can(role, 'messages:use')) {
      out.unread_messages = db.get('SELECT COUNT(*) AS n FROM messages WHERE to_user_id = ? AND read_at IS NULL AND school_id = ?', ctx.user.id, sid).n;
    }
    if (role === 'teacher') {
      out.my_classes = db.all(`SELECT c.id, c.name, (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.status = 'active') AS student_count
        FROM classes c WHERE c.school_id = ? AND c.teacher_id = ? ORDER BY c.id`, sid, ctx.user.id);
    }
    if (can(role, 'audit:read')) {
      out.recent = db.all(`SELECT a.summary, a.action, a.created_at, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.school_id = ? AND a.action NOT LIKE 'auth.%' ORDER BY a.id DESC LIMIT 8`, sid);
    }
    return out;
  });

  // Analytics for leadership and the bursar
  r.get('/api/reports/overview', { perm: 'reports:read' }, (ctx) => {
    const sid = ctx.schoolId; const role = ctx.user.role;
    const period = shared.currentPeriod(sid);
    const out = { period };

    out.enrollment = db.all(`SELECT c.name AS class_name, COUNT(s.id) AS total, COALESCE(SUM(s.gender = 'male'), 0) AS male, COALESCE(SUM(s.gender = 'female'), 0) AS female
      FROM classes c LEFT JOIN students s ON s.class_id = c.id AND s.status = 'active' WHERE c.school_id = ? GROUP BY c.id ORDER BY c.id`, sid);

    if (can(role, 'attendance:read')) {
      out.attendance_by_class = db.all(`SELECT c.name AS class_name, COUNT(a.id) AS marks,
        CASE WHEN COUNT(a.id) = 0 THEN NULL ELSE ROUND(100.0 * SUM(a.status IN ('present','late')) / COUNT(a.id)) END AS rate
        FROM classes c LEFT JOIN students s ON s.class_id = c.id LEFT JOIN attendance a ON a.student_id = s.id AND a.date >= ?
        WHERE c.school_id = ? GROUP BY c.id ORDER BY c.id`, daysAgo(29), sid);
    }

    if (can(role, 'fees:read')) {
      out.fees = shared.feeStats(sid, period.year);
      out.fees_by_class = db.all(`SELECT COALESCE(c.name, 'No class') AS class_name, COALESCE(SUM(i.amount), 0) AS billed, COALESCE(SUM(${PAID}), 0) AS collected
        FROM invoices i JOIN students s ON s.id = i.student_id LEFT JOIN classes c ON c.id = s.class_id
        WHERE i.school_id = ? AND i.academic_year IS ? GROUP BY c.id ORDER BY c.id`, sid, period.year);
      const aging = db.get(`SELECT COUNT(*) AS invoices, COALESCE(SUM(t.amount - t.paid), 0) AS amount FROM
        (SELECT i.amount, i.due_date, ${PAID} AS paid FROM invoices i WHERE i.school_id = ?) t
        WHERE t.amount > t.paid AND t.due_date IS NOT NULL AND t.due_date < ?`, sid, today());
      out.overdue = aging;
      out.recent_payments = db.all(`SELECT p.receipt_no, p.amount, p.method, p.received_at, s.first_name, s.last_name FROM payments p
        JOIN students s ON s.id = p.student_id WHERE p.school_id = ? ORDER BY p.id DESC LIMIT 6`, sid);
    }

    if (can(role, 'results:read')) {
      const scale = parseScale(db.get('SELECT grading_scale FROM schools WHERE id = ?', sid).grading_scale);
      out.subject_averages = db.all(`SELECT sub.name AS subject, ROUND(AVG(r.total), 1) AS average, COUNT(*) AS scores
        FROM results r JOIN subjects sub ON sub.id = r.subject_id
        WHERE r.school_id = ? AND r.academic_year = ? AND r.term = ? AND r.total IS NOT NULL GROUP BY sub.id ORDER BY average DESC`, sid, period.year, period.term);
      const dist = {};
      for (const g of scale) dist[g.grade] = 0;
      for (const x of db.all('SELECT total FROM results WHERE school_id = ? AND academic_year = ? AND term = ? AND total IS NOT NULL', sid, period.year, period.term)) {
        dist[gradeFor(x.total, scale).grade]++;
      }
      out.grade_distribution = Object.entries(dist).map(([grade, count]) => ({ grade, count }));
    }
    return out;
  });
};
