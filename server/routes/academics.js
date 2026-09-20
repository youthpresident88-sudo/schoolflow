'use strict';
const { v, bad, obj, HttpError, notFound } = require('../lib');
const { created } = require('../http');

module.exports = (r, { db, audit }) => {
  const staffMember = (schoolId, id) => db.get("SELECT 1 x FROM users WHERE id = ? AND school_id = ? AND role <> 'parent' AND active = 1", id, schoolId);

  const classList = (schoolId) => db.all(`SELECT c.id, c.name, c.level, c.teacher_id, u.name AS teacher_name,
    (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.status = 'active') AS student_count
    FROM classes c LEFT JOIN users u ON u.id = c.teacher_id WHERE c.school_id = ? ORDER BY c.id`, schoolId);

  r.get('/api/classes', { perm: 'classes:read' }, (ctx) => classList(ctx.schoolId));

  function parseClass(ctx) {
    const d = {
      name: v.str(ctx.body.name, 'Class name', { required: true, max: 60 }),
      level: v.str(ctx.body.level, 'Level', { max: 60 }),
      teacher_id: v.id(ctx.body.teacher_id, 'Class teacher'),
    };
    if (d.teacher_id && !staffMember(ctx.schoolId, d.teacher_id)) throw bad('Unknown staff member');
    return d;
  }

  r.post('/api/classes', { perm: 'classes:write' }, (ctx) => {
    const d = parseClass(ctx);
    if (db.get('SELECT 1 x FROM classes WHERE school_id = ? AND name = ?', ctx.schoolId, d.name)) throw new HttpError(409, 'A class with that name already exists');
    const id = Number(db.run('INSERT INTO classes(school_id,name,level,teacher_id) VALUES (?,?,?,?)', ctx.schoolId, d.name, d.level, d.teacher_id).lastInsertRowid);
    audit(ctx, 'class.created', 'class', id, `Created class ${d.name}`);
    return created(classList(ctx.schoolId).find((c) => c.id === id));
  });

  r.put('/api/classes/:id', { perm: 'classes:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    if (!db.get('SELECT 1 x FROM classes WHERE id = ? AND school_id = ?', id, ctx.schoolId)) throw notFound('Class');
    const d = parseClass(ctx);
    if (db.get('SELECT 1 x FROM classes WHERE school_id = ? AND name = ? AND id <> ?', ctx.schoolId, d.name, id)) throw new HttpError(409, 'A class with that name already exists');
    db.run('UPDATE classes SET name=?, level=?, teacher_id=? WHERE id=? AND school_id=?', d.name, d.level, d.teacher_id, id, ctx.schoolId);
    audit(ctx, 'class.updated', 'class', id, `Updated class ${d.name}`);
    return classList(ctx.schoolId).find((c) => c.id === id);
  });

  r.delete('/api/classes/:id', { perm: 'classes:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    const c = db.get('SELECT name FROM classes WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    if (!c) throw notFound('Class');
    if (db.get('SELECT 1 x FROM students WHERE class_id = ?', id)) throw new HttpError(409, 'Move or promote the students in this class first');
    db.run('DELETE FROM classes WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    audit(ctx, 'class.deleted', 'class', id, `Deleted class ${c.name}`);
  });

  /* ---- subjects ---- */
  r.get('/api/subjects', { perm: 'classes:read' }, (ctx) =>
    db.all('SELECT id, name FROM subjects WHERE school_id = ? ORDER BY name COLLATE NOCASE', ctx.schoolId));

  r.post('/api/subjects', { perm: 'classes:write' }, (ctx) => {
    const name = v.str(ctx.body.name, 'Subject name', { required: true, max: 60 });
    if (db.get('SELECT 1 x FROM subjects WHERE school_id = ? AND name = ?', ctx.schoolId, name)) throw new HttpError(409, 'That subject already exists');
    const id = Number(db.run('INSERT INTO subjects(school_id,name) VALUES (?,?)', ctx.schoolId, name).lastInsertRowid);
    audit(ctx, 'subject.created', 'subject', id, `Added subject ${name}`);
    return created({ id, name });
  });

  r.delete('/api/subjects/:id', { perm: 'classes:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    const s = db.get('SELECT name FROM subjects WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    if (!s) throw notFound('Subject');
    if (db.get('SELECT 1 x FROM results WHERE subject_id = ?', id)) throw new HttpError(409, 'This subject already has results and cannot be deleted');
    db.run('DELETE FROM subjects WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    audit(ctx, 'subject.deleted', 'subject', id, `Deleted subject ${s.name}`);
  });

  /* ---- which subjects a class studies, and who teaches each ---- */
  r.get('/api/classes/:id/subjects', { perm: 'classes:read' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    if (!db.get('SELECT 1 x FROM classes WHERE id = ? AND school_id = ?', id, ctx.schoolId)) throw notFound('Class');
    return db.all(`SELECT cs.subject_id, s.name AS subject, cs.teacher_id, u.name AS teacher_name
      FROM class_subjects cs JOIN subjects s ON s.id = cs.subject_id LEFT JOIN users u ON u.id = cs.teacher_id
      WHERE cs.class_id = ? AND cs.school_id = ? ORDER BY s.name COLLATE NOCASE`, id, ctx.schoolId);
  });

  r.put('/api/classes/:id/subjects', { perm: 'classes:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    if (!db.get('SELECT 1 x FROM classes WHERE id = ? AND school_id = ?', id, ctx.schoolId)) throw notFound('Class');
    if (!Array.isArray(ctx.body.assignments) || ctx.body.assignments.length > 40) throw bad('assignments must be a list of up to 40 subjects');
    const rows = ctx.body.assignments.map((a) => {
      a = obj(a, 'assignment');
      const subjectId = v.id(a.subject_id, 'Subject', { required: true });
      const teacherId = v.id(a.teacher_id, 'Teacher');
      if (!db.get('SELECT 1 x FROM subjects WHERE id = ? AND school_id = ?', subjectId, ctx.schoolId)) throw bad('Unknown subject');
      if (teacherId && !staffMember(ctx.schoolId, teacherId)) throw bad('Unknown teacher');
      return { subjectId, teacherId };
    });
    db.tx(() => {
      db.run('DELETE FROM class_subjects WHERE class_id = ? AND school_id = ?', id, ctx.schoolId);
      for (const x of rows) db.run('INSERT OR REPLACE INTO class_subjects(school_id,class_id,subject_id,teacher_id) VALUES (?,?,?,?)', ctx.schoolId, id, x.subjectId, x.teacherId);
    });
    audit(ctx, 'class.subjects_set', 'class', id, `Set ${rows.length} subject(s) for a class`);
    return db.all(`SELECT cs.subject_id, s.name AS subject, cs.teacher_id, u.name AS teacher_name FROM class_subjects cs
      JOIN subjects s ON s.id = cs.subject_id LEFT JOIN users u ON u.id = cs.teacher_id WHERE cs.class_id = ? ORDER BY s.name COLLATE NOCASE`, id);
  });
};
