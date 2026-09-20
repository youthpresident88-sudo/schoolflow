'use strict';
const { v, bad, obj, HttpError, notFound, parseScale } = require('../lib');

module.exports = (r, { db, audit, shared }) => {
  const period = (ctx) => {
    const cur = shared.currentPeriod(ctx.schoolId);
    return {
      year: v.str(ctx.query.year ?? ctx.body?.academic_year, 'Academic year', { max: 20 }) || cur.year,
      term: v.int(ctx.query.term ?? ctx.body?.term, 'Term', { min: 1, max: 4 }) || cur.term,
    };
  };
  const classOr404 = (ctx, id) => {
    const c = db.get('SELECT id, name FROM classes WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    if (!c) throw notFound('Class');
    return c;
  };
  const scoreVal = (x, name, max) => {
    if (x === null || x === undefined || x === '') return null;
    const n = typeof x === 'string' ? Number(x) : x;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max) throw bad(`${name} must be between 0 and ${max}`);
    return Math.round(n * 10) / 10;
  };

  // Which class + subject combinations this user may enter scores for (drives the pickers in the UI)
  r.get('/api/results/options', { perm: 'results:read' }, (ctx) => {
    const me = ctx.user.id; const lead = shared.leadership(ctx.user);
    const classes = db.all('SELECT id, name, teacher_id FROM classes WHERE school_id = ? ORDER BY id', ctx.schoolId);
    const subjects = db.all('SELECT id, name FROM subjects WHERE school_id = ? ORDER BY name COLLATE NOCASE', ctx.schoolId);
    const cs = db.all('SELECT class_id, subject_id, teacher_id FROM class_subjects WHERE school_id = ?', ctx.schoolId);
    const name = new Map(subjects.map((s) => [s.id, s.name]));
    return classes.map((c) => {
      const assigned = cs.filter((x) => x.class_id === c.id);
      let list;
      if (lead || c.teacher_id === me) list = assigned.length ? assigned.map((x) => x.subject_id) : subjects.map((s) => s.id);
      else list = assigned.filter((x) => x.teacher_id === me).map((x) => x.subject_id);
      return { id: c.id, name: c.name, is_class_teacher: c.teacher_id === me, subjects: list.map((id) => ({ id, name: name.get(id) })) };
    }).filter((c) => c.subjects.length);
  });

  /* ---- score entry (class score + exam score) ---- */
  r.get('/api/results', { perm: 'results:read' }, (ctx) => {
    const classId = v.id(ctx.query.class_id, 'Class', { required: true });
    const subjectId = v.id(ctx.query.subject_id, 'Subject', { required: true });
    classOr404(ctx, classId);
    if (!shared.canEnterResults(ctx.user, classId, subjectId)) throw new HttpError(403, 'You are not assigned to this subject for this class');
    const { year, term } = period(ctx);
    const school = db.get('SELECT ca_max, exam_max, grading_scale FROM schools WHERE id = ?', ctx.schoolId);
    const records = db.all(`SELECT s.id AS student_id, s.admission_no, s.first_name, s.last_name, r.ca_score, r.exam_score, r.total
      FROM students s LEFT JOIN results r ON r.student_id = s.id AND r.subject_id = ? AND r.academic_year = ? AND r.term = ?
      WHERE s.school_id = ? AND s.class_id = ? AND s.status = 'active' ORDER BY s.first_name COLLATE NOCASE, s.last_name COLLATE NOCASE`,
    subjectId, year, term, ctx.schoolId, classId);
    return { class_id: classId, subject_id: subjectId, academic_year: year, term, ca_max: school.ca_max, exam_max: school.exam_max, scale: parseScale(school.grading_scale),
      published: shared.isPublished(ctx.schoolId, classId, year, term), records };
  });

  r.put('/api/results', { perm: 'results:write' }, (ctx) => {
    const classId = v.id(ctx.body.class_id, 'Class', { required: true });
    const subjectId = v.id(ctx.body.subject_id, 'Subject', { required: true });
    const cls = classOr404(ctx, classId);
    if (!db.get('SELECT 1 x FROM subjects WHERE id = ? AND school_id = ?', subjectId, ctx.schoolId)) throw notFound('Subject');
    if (!shared.canEnterResults(ctx.user, classId, subjectId)) throw new HttpError(403, 'You are not assigned to this subject for this class');
    const { year, term } = period(ctx);
    if (shared.isPublished(ctx.schoolId, classId, year, term)) throw new HttpError(409, 'These results are published. Unpublish them before making changes');
    const school = db.get('SELECT ca_max, exam_max FROM schools WHERE id = ?', ctx.schoolId);
    if (!Array.isArray(ctx.body.records) || ctx.body.records.length === 0 || ctx.body.records.length > 500) throw bad('records must list 1–500 students');
    const roster = new Set(db.all("SELECT id FROM students WHERE school_id = ? AND class_id = ? AND status = 'active'", ctx.schoolId, classId).map((x) => x.id));
    const rows = ctx.body.records.map((rec) => {
      rec = obj(rec, 'record');
      const sid = v.id(rec.student_id, 'Student', { required: true });
      if (!roster.has(sid)) throw bad('A student in the list is not in this class');
      return { sid, ca: scoreVal(rec.ca_score, `Class score (max ${school.ca_max})`, school.ca_max), exam: scoreVal(rec.exam_score, `Exam score (max ${school.exam_max})`, school.exam_max) };
    });
    db.tx(() => {
      for (const x of rows) {
        if (x.ca === null && x.exam === null) {
          db.run('DELETE FROM results WHERE student_id = ? AND subject_id = ? AND academic_year = ? AND term = ? AND school_id = ?', x.sid, subjectId, year, term, ctx.schoolId);
        } else {
          db.run(`INSERT INTO results(school_id,student_id,subject_id,academic_year,term,ca_score,exam_score,entered_by) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(student_id,subject_id,academic_year,term) DO UPDATE SET ca_score = excluded.ca_score, exam_score = excluded.exam_score, entered_by = excluded.entered_by`,
          ctx.schoolId, x.sid, subjectId, year, term, x.ca, x.exam, ctx.user.id);
        }
      }
    });
    audit(ctx, 'results.saved', 'class', classId, `Scores saved for ${cls.name} (${rows.length} students, term ${term} ${year})`);
    return { saved: rows.length };
  });

  /* ---- report cards ---- */
  const canSeeReport = (ctx, classId) => shared.isClassTeacher(ctx.user, classId);

  r.get('/api/students/:id/report', { perm: 'results:read' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    const st = db.get('SELECT class_id FROM students WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    if (!st) throw notFound('Student');
    if (!canSeeReport(ctx, st.class_id)) throw new HttpError(403, 'Only the class teacher or school leadership can view report cards');
    const { year, term } = period(ctx);
    const report = shared.buildReport(ctx.schoolId, id, year, term, { issue: true });
    report.published = shared.isPublished(ctx.schoolId, st.class_id, year, term);
    return report;
  });

  r.put('/api/students/:id/report-meta', { perm: 'results:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    const st = db.get('SELECT class_id FROM students WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    if (!st) throw notFound('Student');
    if (!canSeeReport(ctx, st.class_id)) throw new HttpError(403, 'Only the class teacher or school leadership can write remarks');
    const year = v.str(ctx.body.academic_year, 'Academic year', { max: 20 }) || shared.currentPeriod(ctx.schoolId).year;
    const term = v.int(ctx.body.term, 'Term', { min: 1, max: 4 }) || shared.currentPeriod(ctx.schoolId).term;
    const cur = db.get('SELECT * FROM report_meta WHERE student_id = ? AND academic_year = ? AND term = ?', id, year, term) || {};
    const lead = shared.leadership(ctx.user);
    const next = {
      teacher_remark: ctx.body.teacher_remark === undefined ? cur.teacher_remark : v.str(ctx.body.teacher_remark, 'Teacher remark', { max: 300 }),
      conduct: ctx.body.conduct === undefined ? cur.conduct : v.str(ctx.body.conduct, 'Conduct', { max: 60 }),
      head_remark: cur.head_remark,
    };
    if (ctx.body.head_remark !== undefined) {
      if (!lead) throw new HttpError(403, "Only the head or administrator can write the head's remark");
      next.head_remark = v.str(ctx.body.head_remark, "Head's remark", { max: 300 });
    }
    db.run(`INSERT INTO report_meta(school_id,student_id,academic_year,term,teacher_remark,head_remark,conduct) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(student_id,academic_year,term) DO UPDATE SET teacher_remark=excluded.teacher_remark, head_remark=excluded.head_remark, conduct=excluded.conduct`,
    ctx.schoolId, id, year, term, next.teacher_remark ?? null, next.head_remark ?? null, next.conduct ?? null);
    audit(ctx, 'report.remarks', 'student', id, 'Report card remarks updated');
    return next;
  });

  // Class broadsheet: everyone's average and position for a term
  r.get('/api/reports/class', { perm: 'results:read' }, (ctx) => {
    const classId = v.id(ctx.query.class_id, 'Class', { required: true });
    classOr404(ctx, classId);
    if (!canSeeReport(ctx, classId)) throw new HttpError(403, 'Only the class teacher or school leadership can view the class summary');
    const { year, term } = period(ctx);
    const students = db.all("SELECT id FROM students WHERE school_id = ? AND class_id = ? AND status = 'active'", ctx.schoolId, classId);
    const rows = students.map((s) => {
      const rep = shared.buildReport(ctx.schoolId, s.id, year, term);
      return { student_id: s.id, name: rep.student.name, admission_no: rep.student.admission_no, subjects: rep.overall.subjects_count,
        total: rep.overall.total, average: rep.overall.average, grade: rep.overall.grade, position: rep.overall.position };
    }).sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || a.name.localeCompare(b.name));
    return { class_id: classId, academic_year: year, term, published: shared.isPublished(ctx.schoolId, classId, year, term), students: rows, out_of: rows.filter((x) => x.position).length };
  });

  r.post('/api/reports/publish', { perm: 'results:publish' }, (ctx) => {
    const classId = v.id(ctx.body.class_id, 'Class', { required: true });
    const cls = classOr404(ctx, classId);
    const { year, term } = period(ctx);
    if (ctx.body.publish === false) {
      db.run('DELETE FROM published_reports WHERE class_id = ? AND academic_year = ? AND term = ? AND school_id = ?', classId, year, term, ctx.schoolId);
    } else {
      db.run('INSERT OR REPLACE INTO published_reports(school_id,class_id,academic_year,term,published_by) VALUES (?,?,?,?,?)', ctx.schoolId, classId, year, term, ctx.user.id);
    }
    audit(ctx, ctx.body.publish === false ? 'reports.unpublished' : 'reports.published', 'class', classId, `${ctx.body.publish === false ? 'Unpublished' : 'Published'} term ${term} ${year} report cards for ${cls.name}`);
    return { published: ctx.body.publish !== false };
  });
};
