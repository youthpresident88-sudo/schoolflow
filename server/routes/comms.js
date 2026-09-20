'use strict';
const { v, bad, HttpError, notFound, paging, today } = require('../lib');
const { created } = require('../http');

const AUDIENCES = ['all', 'staff', 'parents', 'students'];

module.exports = (r, { db, audit, shared, notifier }) => {
  /* ---------------- announcements ---------------- */
  r.get('/api/announcements', { perm: 'announcements:read' }, (ctx) =>
    db.all(`SELECT a.id, a.title, a.body, a.audience, a.class_id, a.created_by, c.name AS class_name, a.created_at, u.name AS author
      FROM announcements a LEFT JOIN users u ON u.id = a.created_by LEFT JOIN classes c ON c.id = a.class_id
      WHERE a.school_id = ? ORDER BY a.id DESC LIMIT 100`, ctx.schoolId));

  r.post('/api/announcements', { perm: 'announcements:write' }, (ctx) => {
    const d = {
      title: v.str(ctx.body.title, 'Title', { required: true, max: 120 }),
      body: v.str(ctx.body.body, 'Message', { required: true, max: 2000 }),
      audience: v.enum(ctx.body.audience, 'Audience', AUDIENCES, { def: 'all' }),
      classId: v.id(ctx.body.class_id, 'Class'),
    };
    if (d.classId && !db.get('SELECT 1 x FROM classes WHERE id = ? AND school_id = ?', d.classId, ctx.schoolId)) throw bad('Unknown class');
    if (!shared.leadership(ctx.user)) { // teachers may only write to their own class's parents
      if (!d.classId || !shared.isClassTeacher(ctx.user, d.classId)) throw new HttpError(403, 'Teachers can only post to their own class');
      d.audience = 'parents';
    }
    const channels = Array.isArray(ctx.body.notify) ? ctx.body.notify.filter((c) => c === 'sms' || c === 'email') : [];
    const id = Number(db.run('INSERT INTO announcements(school_id,title,body,audience,class_id,created_by) VALUES (?,?,?,?,?,?)',
      ctx.schoolId, d.title, d.body, d.audience, d.classId, ctx.user.id).lastInsertRowid);

    const queued = { sms: 0, email: 0 };
    if (channels.length) {
      const school = db.get('SELECT name FROM schools WHERE id = ?', ctx.schoolId);
      const seen = new Set();
      const send = (channel, to) => {
        const key = `${channel}:${String(to).toLowerCase()}`;
        if (!to || seen.has(key) || seen.size >= 2000) return;
        if (notifier.enqueue(ctx.schoolId, { channel, to, subject: channel === 'email' ? d.title : null,
          body: channel === 'sms' ? `${school.name}: ${d.title} — ${d.body}` : d.body, related: `announcement:${id}`, userId: ctx.user.id })) {
          seen.add(key); queued[channel]++;
        }
      };
      if (d.audience === 'all' || d.audience === 'parents') {
        const guardians = db.all(`SELECT g.phone, g.email FROM guardians g JOIN students s ON s.id = g.student_id
          WHERE g.school_id = ? AND s.status = 'active' AND (? IS NULL OR s.class_id = ?)`, ctx.schoolId, d.classId, d.classId);
        for (const g of guardians) { if (channels.includes('sms')) send('sms', g.phone); if (channels.includes('email')) send('email', g.email); }
      }
      if (d.audience === 'all' || d.audience === 'staff') {
        for (const u of db.all("SELECT phone, email FROM users WHERE school_id = ? AND active = 1 AND role <> 'parent'", ctx.schoolId)) {
          if (channels.includes('sms')) send('sms', u.phone);
          if (channels.includes('email')) send('email', u.email);
        }
      }
    }
    audit(ctx, 'announcement.posted', 'announcement', id, `Posted “${d.title}”${queued.sms + queued.email ? ` (${queued.sms} SMS, ${queued.email} email queued)` : ''}`);
    return created({ id, queued });
  });

  r.delete('/api/announcements/:id', { perm: 'announcements:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    const a = db.get('SELECT created_by FROM announcements WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    if (!a) throw notFound('Announcement');
    if (!shared.leadership(ctx.user) && a.created_by !== ctx.user.id) throw new HttpError(403, 'You can only delete your own announcements');
    db.run('DELETE FROM announcements WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    audit(ctx, 'announcement.deleted', 'announcement', id, 'Deleted an announcement');
  });

  /* ---------------- events ---------------- */
  r.get('/api/events', { perm: 'events:read' }, (ctx) => {
    const from = v.date(ctx.query.from, 'From') || today();
    return db.all(`SELECT id, title, description, location, start_date, end_date, audience FROM events
      WHERE school_id = ? AND COALESCE(end_date, start_date) >= ? ORDER BY start_date, id LIMIT 200`, ctx.schoolId, from);
  });

  function parseEvent(body) {
    const d = {
      title: v.str(body.title, 'Title', { required: true, max: 120 }),
      description: v.str(body.description, 'Description', { max: 1000 }),
      location: v.str(body.location, 'Location', { max: 120 }),
      start: v.date(body.start_date, 'Start date', { required: true }),
      end: v.date(body.end_date, 'End date'),
      audience: v.enum(body.audience, 'Audience', AUDIENCES, { def: 'all' }),
    };
    if (d.end && d.end < d.start) throw bad('End date must be on or after the start date');
    return d;
  }

  r.post('/api/events', { perm: 'events:write' }, (ctx) => {
    const d = parseEvent(ctx.body);
    const id = Number(db.run('INSERT INTO events(school_id,title,description,location,start_date,end_date,audience,created_by) VALUES (?,?,?,?,?,?,?,?)',
      ctx.schoolId, d.title, d.description, d.location, d.start, d.end, d.audience, ctx.user.id).lastInsertRowid);
    audit(ctx, 'event.created', 'event', id, `Created event “${d.title}”`);
    return created({ id, ...d });
  });

  r.put('/api/events/:id', { perm: 'events:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    if (!db.get('SELECT 1 x FROM events WHERE id = ? AND school_id = ?', id, ctx.schoolId)) throw notFound('Event');
    const d = parseEvent(ctx.body);
    db.run('UPDATE events SET title=?, description=?, location=?, start_date=?, end_date=?, audience=? WHERE id=? AND school_id=?',
      d.title, d.description, d.location, d.start, d.end, d.audience, id, ctx.schoolId);
    audit(ctx, 'event.updated', 'event', id, `Updated event “${d.title}”`);
    return { id, ...d };
  });

  r.delete('/api/events/:id', { perm: 'events:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    if (!db.get('SELECT 1 x FROM events WHERE id = ? AND school_id = ?', id, ctx.schoolId)) throw notFound('Event');
    db.run('DELETE FROM events WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    audit(ctx, 'event.deleted', 'event', id, 'Deleted an event');
  });

  /* ---------------- tasks (admin assigns work to staff) ---------------- */
  r.get('/api/tasks', { perm: 'tasks:read' }, (ctx) => {
    const mine = !shared.leadership(ctx.user);
    const rows = db.all(`SELECT t.id, t.title, t.description, t.due_date, t.status, t.done_at, t.created_at, t.assigned_to, a.name AS assignee, c.name AS created_by_name
      FROM tasks t JOIN users a ON a.id = t.assigned_to LEFT JOIN users c ON c.id = t.created_by
      WHERE t.school_id = ? AND (? = 0 OR t.assigned_to = ?) ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.id DESC LIMIT 200`,
    ctx.schoolId, mine ? 1 : 0, ctx.user.id);
    return rows.map((t) => ({ ...t, overdue: t.status === 'open' && !!t.due_date && t.due_date < today() }));
  });

  r.post('/api/tasks', { perm: 'tasks:write' }, (ctx) => {
    const assignee = v.id(ctx.body.assigned_to, 'Assign to', { required: true });
    if (!db.get("SELECT 1 x FROM users WHERE id = ? AND school_id = ? AND active = 1 AND role <> 'parent'", assignee, ctx.schoolId)) throw bad('Unknown staff member');
    const d = { title: v.str(ctx.body.title, 'Title', { required: true, max: 120 }), description: v.str(ctx.body.description, 'Details', { max: 1000 }), due: v.date(ctx.body.due_date, 'Due date') };
    const id = Number(db.run('INSERT INTO tasks(school_id,title,description,due_date,assigned_to,created_by) VALUES (?,?,?,?,?,?)',
      ctx.schoolId, d.title, d.description, d.due, assignee, ctx.user.id).lastInsertRowid);
    audit(ctx, 'task.assigned', 'task', id, `Assigned task “${d.title}”`);
    return created({ id });
  });

  r.put('/api/tasks/:id/status', { perm: 'tasks:read' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    const t = db.get('SELECT assigned_to, title FROM tasks WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    if (!t) throw notFound('Task');
    if (t.assigned_to !== ctx.user.id && !shared.leadership(ctx.user)) throw new HttpError(403, 'This task is assigned to someone else');
    const status = v.enum(ctx.body.status, 'Status', ['open', 'done'], { required: true });
    db.run("UPDATE tasks SET status = ?, done_at = CASE WHEN ? = 'done' THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') END WHERE id = ?", status, status, id);
    audit(ctx, 'task.status', 'task', id, `Task “${t.title}” marked ${status}`);
    return { status };
  });

  r.delete('/api/tasks/:id', { perm: 'tasks:write' }, (ctx) => {
    const id = v.id(ctx.params.id, 'id', { required: true });
    if (!db.get('SELECT 1 x FROM tasks WHERE id = ? AND school_id = ?', id, ctx.schoolId)) throw notFound('Task');
    db.run('DELETE FROM tasks WHERE id = ? AND school_id = ?', id, ctx.schoolId);
    audit(ctx, 'task.deleted', 'task', id, 'Deleted a task');
  });

  /* ---------------- direct messages (staff <-> parents, staff <-> staff) ---------------- */
  const MSG = { perm: 'messages:use' };

  r.get('/api/messages/contacts', MSG, (ctx) => {
    const parent = ctx.user.role === 'parent';
    return db.all(`SELECT id, name, role FROM users WHERE school_id = ? AND active = 1 AND id <> ? AND (? = 0 OR role <> 'parent')
      ORDER BY role = 'parent', name COLLATE NOCASE LIMIT 300`, ctx.schoolId, ctx.user.id, parent ? 1 : 0);
  });

  r.get('/api/messages/threads', MSG, (ctx) => {
    const me = ctx.user.id;
    return db.all(`SELECT t.other_id AS user_id, u.name, u.role, m.body AS last_body, m.created_at AS last_at,
        (SELECT COUNT(*) FROM messages x WHERE x.from_user_id = t.other_id AND x.to_user_id = ? AND x.read_at IS NULL) AS unread
      FROM (SELECT CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END AS other_id, MAX(id) AS last_id
            FROM messages WHERE school_id = ? AND (from_user_id = ? OR to_user_id = ?) GROUP BY other_id) t
      JOIN messages m ON m.id = t.last_id JOIN users u ON u.id = t.other_id ORDER BY m.id DESC`, me, me, ctx.schoolId, me, me);
  });

  r.get('/api/messages/unread', MSG, (ctx) => ({
    unread: db.get('SELECT COUNT(*) AS n FROM messages WHERE to_user_id = ? AND read_at IS NULL AND school_id = ?', ctx.user.id, ctx.schoolId).n,
  }));

  r.get('/api/messages/with/:userId', MSG, (ctx) => {
    const other = v.id(ctx.params.userId, 'user', { required: true });
    const u = db.get('SELECT id, name, role FROM users WHERE id = ? AND school_id = ?', other, ctx.schoolId);
    if (!u) throw notFound('User');
    db.run("UPDATE messages SET read_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE from_user_id = ? AND to_user_id = ? AND read_at IS NULL AND school_id = ?", other, ctx.user.id, ctx.schoolId);
    const messages = db.all(`SELECT id, from_user_id, body, created_at, read_at FROM messages WHERE school_id = ?
      AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)) ORDER BY id DESC LIMIT 100`, ctx.schoolId, ctx.user.id, other, other, ctx.user.id).reverse();
    return { user: u, messages };
  });

  r.post('/api/messages', MSG, (ctx) => {
    const to = v.id(ctx.body.to_user_id, 'Recipient', { required: true });
    const body = v.str(ctx.body.body, 'Message', { required: true, max: 1000 });
    const u = db.get('SELECT id, role FROM users WHERE id = ? AND school_id = ? AND active = 1', to, ctx.schoolId);
    if (!u || u.id === ctx.user.id) throw bad('Unknown recipient');
    if (ctx.user.role === 'parent' && u.role === 'parent') throw new HttpError(403, 'Parents can message school staff only');
    const id = Number(db.run('INSERT INTO messages(school_id,from_user_id,to_user_id,body) VALUES (?,?,?,?)', ctx.schoolId, ctx.user.id, to, body).lastInsertRowid);
    return created({ id });
  });

  /* ---------------- SMS / email outbox ---------------- */
  r.get('/api/notifications', { perm: 'audit:read' }, (ctx) => {
    const { page, limit, offset } = paging(ctx.query);
    const total = db.get('SELECT COUNT(*) AS n FROM notifications WHERE school_id = ?', ctx.schoolId).n;
    const counts = db.all('SELECT status, COUNT(*) AS n FROM notifications WHERE school_id = ? GROUP BY status', ctx.schoolId);
    const items = db.all(`SELECT id, channel, recipient, subject, body, status, attempts, error, created_at, sent_at FROM notifications
      WHERE school_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`, ctx.schoolId, limit, offset);
    return { items, total, page, limit, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
  });

  r.post('/api/notifications/process', { perm: 'settings:write' }, async () => ({ processed: await notifier.processQueue(100) }));
};
