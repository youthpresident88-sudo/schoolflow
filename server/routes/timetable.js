'use strict';
const { v, bad, HttpError, notFound } = require('../lib');
const { created } = require('../http');

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

module.exports = (r, { db, audit }) => {
  const SELECT = `SELECT t.id, t.class_id, c.name AS class_name, t.subject_id, s.name AS subject, t.teacher_id, u.name AS teacher_name,
      t.day, t.start_time, t.end_time, t.room
    FROM timetable t JOIN classes c ON c.id = t.class_id LEFT JOIN subjects s ON s.id = t.subject_id LEFT JOIN users u ON u.id = t.teacher_id`;

  r.get('/api/timetable', { perm: 'timetable:read' }, (ctx) => {
    const classId = v.id(ctx.query.class_id, 'Class');
    const teacherId = v.id(ctx.query.teacher_id, 'Teacher');
    if (!classId && !teacherId) throw bad('Provide class_id or teacher_id');
    return db.all(`${SELECT} WHERE t.school_id = ? AND (? IS NULL OR t.class_id = ?) AND (? IS NULL OR t.teacher_id = ?)
      ORDER BY t.day, t.start_time`, ctx.schoolId, classId, classId, teacherId, teacherId);
  });

  function parse(ctx, selfId = 0) {
    const b = ctx.body;
    const d = {
      classId: v.id(b.class_id, 'Class', { required: true }),
      subjectId: v.id(b.subject_id, 'Subject'),
      teacherId: v.id(b.teacher_id, 'Teacher'),
      day: v.int(b.day, 'Day', { min: 1, max: 7, required: true }),
      start: v.str(b.start_time, 'Start time', { required: true, max: 5 }),
      end: v.str(b.end_time, 'End time', { required: true, max: 5 }),
      room: v.str(b.room, 'Room', { max: 40 }),
    };
    if (!TIME.test(d.start) || !TIME.test(d.end)) throw bad('Times must look like 08:30');
    if (d.end <= d.start) throw bad('End time must be after the start time');
    if (!db.get('SELECT 1 x FROM classes WHERE id = ? AND school_id = ?', d.classId, ctx.schoolId)) throw bad('Unknown class');
    if (d.subjectId && !db.get('SELECT 1 x FROM subjects WHERE id = ? AND school_id = ?', d.subjectId, ctx.schoolId)) throw bad('Unknown subject');
    if (d.teacherId && !db.get("SELECT 1 x FROM users WHERE id = ? AND school_id = ? AND role <> 'parent'", d.teacherId, ctx.schoolId)) throw bad('Unknown teacher');
    const overlap = 'day = ? AND start_time < ? AND end_time > ? AND id <> ? AND school_id = ?';
    if (db.get(`SELECT 1 x FROM timetable WHERE class_id = ? AND ${overlap}`, d.classId, d.day, d.end, d.start, selfId, ctx.schoolId)) {
      throw new HttpError(409, 'This class already has a lesson at that time');
    }
    if (d.teacherId && db.get(`SELECT 1 x FROM timetable WHERE teacher_id = ? AND ${overlap}`, d.teacherId, d.day, d.end, d.start, selfId, ctx.schoolId)) {
      throw new HttpError(409, 'That teacher is already teaching another class at that time');
    }
    return d;
  }

  r.post('/api/timetable', { perm: 'timetable:write' }, (ctx) => {
    const d = parse(ctx);
    const id = Number(db.run('INSERT INTO timetable(school_id,class_id,subject_id,teacher_id,day,start_time,end_time,room) VALUES (?,?,?,?,?,?,?,?)',
      ctx.schoolId, d.classId, d.subjectId, d.teacherId, d.day, d.start, d.end, d.room).lastInsertRowid);
    audit(ctx, 'timetable.added', 'timetable', id, 'Added a timetable lesson');
    return created(db.get(`${SELECT} WHERE t.id = ?`, id));
  });

  r.put('/api/timetable/:id', { perm: 'timetable:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    if (!db.get('SELECT 1 x FROM timetable WHERE id = ? AND school_id = ?', id, ctx.schoolId)) throw notFound('Lesson');
    const d = parse(ctx, id);
    db.run('UPDATE timetable SET class_id=?, subject_id=?, teacher_id=?, day=?, start_time=?, end_time=?, room=? WHERE id=? AND school_id=?',
      d.classId, d.subjectId, d.teacherId, d.day, d.start, d.end, d.room, id, ctx.schoolId);
    audit(ctx, 'timetable.updated', 'timetable', id, 'Updated a timetable lesson');
    return db.get(`${SELECT} WHERE t.id = ?`, id);
  });

  r.delete('/api/timetable/:id', { perm: 'timetable:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    if (!db.get('SELECT 1 x FROM timetable WHERE id = ? AND school_id = ?', id, ctx.schoolId)) throw notFound('Lesson');
    db.run('DELETE FROM timetable WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    audit(ctx, 'timetable.deleted', 'timetable', id, 'Removed a timetable lesson');
  });
};
