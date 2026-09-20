'use strict';
const crypto = require('node:crypto');
const { notFound, parseScale, gradeFor, withPositions } = require('./lib');

module.exports = (db) => {
  const round1 = (n) => Math.round(n * 10) / 10;

  function currentPeriod(schoolId) {
    const s = db.get('SELECT academic_year, current_term FROM schools WHERE id = ?', schoolId);
    return { year: s.academic_year, term: s.current_term };
  }

  const termDates = (schoolId, year, term) =>
    db.get('SELECT start_date, end_date, next_term_begins FROM terms WHERE school_id = ? AND academic_year = ? AND term = ?', schoolId, year, term) || {};

  function attendanceSummary(schoolId, studentId, from = null, to = null) {
    const rows = db.all(`SELECT status, COUNT(*) AS n FROM attendance
      WHERE school_id = ? AND student_id = ? AND (? IS NULL OR date >= ?) AND (? IS NULL OR date <= ?) GROUP BY status`,
    schoolId, studentId, from, from, to, to);
    const out = { present: 0, late: 0, absent: 0, excused: 0, total: 0, rate: null };
    for (const r of rows) { out[r.status] = r.n; out.total += r.n; }
    if (out.total) out.rate = Math.round(((out.present + out.late) / out.total) * 100);
    return out;
  }

  function studentBalance(schoolId, studentId) {
    const billed = db.get('SELECT COALESCE(SUM(amount),0) AS n FROM invoices WHERE school_id = ? AND student_id = ?', schoolId, studentId).n;
    const paid = db.get('SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE school_id = ? AND student_id = ?', schoolId, studentId).n;
    return { billed, paid, balance: billed - paid };
  }

  function verificationCode(schoolId, studentId, year, term) {
    const existing = db.get('SELECT code FROM report_verifications WHERE student_id = ? AND academic_year = ? AND term = ?', studentId, year, term);
    if (existing) return existing.code;
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const part = () => Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join('');
    const code = `SF-${part()}-${part()}`;
    db.run('INSERT INTO report_verifications(code,school_id,student_id,academic_year,term) VALUES (?,?,?,?,?)', code, schoolId, studentId, year, term);
    return code;
  }

  // Full report card with subject and overall class positions (ties share a position).
  function buildReport(schoolId, studentId, year, term, { issue = false } = {}) {
    const school = db.get('SELECT name, motto, logo, ca_max, exam_max, grading_scale FROM schools WHERE id = ?', schoolId);
    const scale = parseScale(school.grading_scale);
    const st = db.get(`SELECT s.id, s.admission_no, s.first_name, s.last_name, s.gender, s.class_id, c.name AS class_name
      FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.id = ? AND s.school_id = ?`, studentId, schoolId);
    if (!st) throw notFound('Student');

    const own = db.all(`SELECT sub.id AS subject_id, sub.name AS subject, r.ca_score, r.exam_score, r.total
      FROM results r JOIN subjects sub ON sub.id = r.subject_id
      WHERE r.school_id = ? AND r.student_id = ? AND r.academic_year = ? AND r.term = ? ORDER BY sub.name`, schoolId, studentId, year, term);

    // classmates' totals, used only to compute positions
    const peers = st.class_id ? db.all(`SELECT r.student_id, r.subject_id, r.total FROM results r JOIN students s ON s.id = r.student_id
      WHERE r.school_id = ? AND r.academic_year = ? AND r.term = ? AND s.class_id = ? AND (s.status = 'active' OR s.id = ?) AND r.total IS NOT NULL`,
    schoolId, year, term, st.class_id, studentId) : [];

    const bySubject = new Map();
    for (const p of peers) { if (!bySubject.has(p.subject_id)) bySubject.set(p.subject_id, []); bySubject.get(p.subject_id).push({ ...p }); }
    const subjectPos = new Map();
    for (const [sid, list] of bySubject) {
      withPositions(list, 'total');
      const mine = list.find((x) => x.student_id === studentId);
      if (mine) subjectPos.set(sid, { position: mine.position, out_of: list.length });
    }

    const subjects = own.map((r) => {
      const complete = r.total !== null;
      const g = complete ? gradeFor(r.total, scale) : { grade: null, remark: null };
      const pos = subjectPos.get(r.subject_id);
      return { subject: r.subject, ca_score: r.ca_score, exam_score: r.exam_score, total: r.total, complete, ...g,
        position: pos ? pos.position : null, out_of: pos ? pos.out_of : null };
    });

    const totals = new Map();
    for (const p of peers) {
      const t = totals.get(p.student_id) || { student_id: p.student_id, sum: 0, n: 0 };
      t.sum += p.total; t.n++; totals.set(p.student_id, t);
    }
    const ranked = withPositions([...totals.values()], 'sum');
    const mine = ranked.find((t) => t.student_id === studentId);
    const completeSubjects = subjects.filter((s) => s.complete);
    const sum = completeSubjects.reduce((a, s) => a + s.total, 0);
    const average = completeSubjects.length ? round1(sum / completeSubjects.length) : null;
    const overall = {
      total: completeSubjects.length ? round1(sum) : null, average, subjects_count: completeSubjects.length,
      ...(average === null ? { grade: null, remark: null } : gradeFor(average, scale)),
      position: mine ? mine.position : null, out_of: ranked.length || null,
    };

    const dates = termDates(schoolId, year, term);
    const meta = db.get('SELECT teacher_remark, head_remark, conduct FROM report_meta WHERE student_id = ? AND academic_year = ? AND term = ?', studentId, year, term)
      || { teacher_remark: null, head_remark: null, conduct: null };

    return {
      school: { name: school.name, motto: school.motto, logo: school.logo },
      student: { id: st.id, name: `${st.first_name} ${st.last_name}`, admission_no: st.admission_no, class_id: st.class_id, class_name: st.class_name, gender: st.gender },
      academic_year: year, term, ca_max: school.ca_max, exam_max: school.exam_max, scale,
      subjects, overall,
      attendance: attendanceSummary(schoolId, studentId, dates.start_date || null, dates.end_date || null),
      attendance_scoped_to_term: !!(dates.start_date || dates.end_date),
      meta, next_term_begins: dates.next_term_begins || null,
      verification_code: issue ? verificationCode(schoolId, studentId, year, term) : null,
    };
  }

  const PAID = '(SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id)';
  function feeStats(schoolId, year) {
    const t = db.get(`SELECT COALESCE(SUM(i.amount),0) AS billed, COALESCE(SUM(${PAID}),0) AS collected
      FROM invoices i WHERE i.school_id = ? AND i.academic_year IS ?`, schoolId, year);
    const out = db.get(`SELECT COUNT(*) AS n FROM (SELECT i.student_id FROM invoices i WHERE i.school_id = ? AND i.academic_year IS ?
      GROUP BY i.student_id HAVING SUM(i.amount) > COALESCE(SUM(${PAID}), 0))`, schoolId, year);
    return { academic_year: year, billed: t.billed, collected: t.collected, outstanding: t.billed - t.collected,
      rate: t.billed ? Math.round((t.collected / t.billed) * 100) : null, students_owing: out.n };
  }

  const isPublished = (schoolId, classId, year, term) =>
    !!classId && !!db.get('SELECT 1 x FROM published_reports WHERE school_id = ? AND class_id = ? AND academic_year = ? AND term = ?', schoolId, classId, year, term);

  // Teachers are scoped to their own classes; admin/principal see everything.
  const leadership = (user) => user.role === 'admin' || user.role === 'principal';
  function isClassTeacher(user, classId) {
    if (leadership(user)) return true;
    const c = db.get('SELECT teacher_id FROM classes WHERE id = ? AND school_id = ?', classId, user.school_id);
    return !!c && c.teacher_id === user.id;
  }
  function canEnterResults(user, classId, subjectId) {
    if (isClassTeacher(user, classId)) return true;
    return !!db.get('SELECT 1 x FROM class_subjects WHERE class_id = ? AND subject_id = ? AND teacher_id = ? AND school_id = ?', classId, subjectId, user.id, user.school_id);
  }

  return { currentPeriod, termDates, attendanceSummary, studentBalance, verificationCode, buildReport, feeStats, isPublished, leadership, isClassTeacher, canEnterResults };
};
