'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../db');
const { createApp } = require('../app');

const silent = { log() {}, error() {} };
let base; let app; let db;

test.before(async () => {
  db = openDb(':memory:');
  app = createApp(db, { notifyIntervalMs: 0, logger: silent, registerLimit: 50 });
  await new Promise((res) => app.server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(() => { app.server.close(); });

// tiny client with its own cookie jar
function client() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.()[0];
    if (set) cookie = set.startsWith('sf_session=;') ? '' : set.split(';')[0];
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { call, get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b = {}) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

const S = {}; // shared state across the ordered tests
const ok = (r, status = 200) => assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${JSON.stringify(r.data)}`);

test('register a school, get session, classes and subjects seeded', async () => {
  S.admin = client();
  const r = await S.admin.post('/api/schools', {
    admin: { name: 'Ama Mensah', email: 'ama@greenfield.test', phone: '0241234567', password: 'correct-horse-9' },
    school: { name: 'Greenfield Academy', type: 'Basic School', location: 'Tamale', motto: 'Learn & Lead', levels: 'KG, Primary 1–3', academic_year: '2026/2027', terms: '3 Terms' },
  });
  ok(r, 201);
  assert.equal(r.data.user.role, 'admin');
  assert.equal(r.data.school.slug, 'greenfield-academy');
  assert.ok(r.data.permissions.includes('settings:write'));
  const classes = (await S.admin.get('/api/classes')).data;
  assert.deepEqual(classes.map((c) => c.name), ['KG', 'Primary 1', 'Primary 2', 'Primary 3']);
  S.classes = Object.fromEntries(classes.map((c) => [c.name, c.id]));
  const subjects = (await S.admin.get('/api/subjects')).data;
  assert.ok(subjects.length >= 8);
  S.subjects = Object.fromEntries(subjects.map((s) => [s.name, s.id]));
  assert.equal((await S.admin.get('/api/settings')).data.terms.length, 3);
});

test('duplicate email rejected, weak password rejected, unauthenticated blocked', async () => {
  const anon = client();
  ok(await anon.post('/api/schools', { admin: { name: 'X', email: 'ama@greenfield.test', password: 'longenough1' }, school: { name: 'Other' } }), 409);
  ok(await anon.post('/api/schools', { admin: { name: 'X', email: 'x@y.test', password: 'short' }, school: { name: 'Other' } }), 400);
  ok(await anon.get('/api/students'), 401);
  ok(await anon.get('/api/me'), 401);
});

test('CSRF guards: wrong content-type and cross-origin are refused', async () => {
  const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
  const res2 = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(res2.status, 403);
});

test('staff: teachers get temp passwords, must change them, RBAC enforced', async () => {
  const t1 = await S.admin.post('/api/staff', { name: 'Kofi Teacher', email: 'kofi@greenfield.test', phone: '0201112222', role: 'teacher' });
  ok(t1, 201);
  assert.match(t1.data.temporary_password, /^[A-Za-z0-9]{12}$/);
  S.teacherId = t1.data.staff.id;
  const t2 = await S.admin.post('/api/staff', { name: 'Esi Teacher', email: 'esi@greenfield.test', role: 'teacher' });
  S.teacher2Id = t2.data.staff.id;
  const acc = await S.admin.post('/api/staff', { name: 'Bursar Yaw', email: 'yaw@greenfield.test', role: 'accountant' });
  S.accountant = client();
  ok(await S.accountant.post('/api/auth/login', { email: 'yaw@greenfield.test', password: acc.data.temporary_password }));

  S.teacher = client();
  const login = await S.teacher.post('/api/auth/login', { email: 'kofi@greenfield.test', password: t1.data.temporary_password });
  ok(login);
  assert.equal(login.data.user.must_change_password, true);
  ok(await S.teacher.post('/api/auth/change-password', { current_password: 'wrong', new_password: 'brand-new-pass1' }), 400);
  ok(await S.teacher.post('/api/auth/change-password', { current_password: t1.data.temporary_password, new_password: 'brand-new-pass1' }), 204);
  assert.equal((await S.teacher.get('/api/me')).data.user.must_change_password, false);

  // teachers cannot manage staff, fees or settings
  ok(await S.teacher.post('/api/staff', { name: 'Z', email: 'z@z.test', role: 'teacher' }), 403);
  ok(await S.teacher.post('/api/invoices', { description: 'x', amount: 100 }), 403);
  ok(await S.teacher.put('/api/settings', { name: 'Hacked' }), 403);
  // accountants cannot enter results or see attendance
  ok(await S.accountant.get(`/api/results?class_id=${S.classes.KG}&subject_id=${S.subjects.Mathematics}`), 403);
  ok(await S.accountant.get(`/api/attendance?class_id=${S.classes.KG}`), 403);
});

test('students: create with guardians, search, update, validation', async () => {
  const mk = (first, last, cls, gender, phone) => S.admin.post('/api/students', {
    first_name: first, last_name: last, gender, dob: '2018-05-01', class_id: S.classes[cls],
    guardians: [{ name: `${first}'s parent`, relationship: 'Mother', phone, email: `${first.toLowerCase()}.parent@mail.test` }],
  });
  const a = await mk('Abena', 'Owusu', 'Primary 1', 'female', '0244000001'); ok(a, 201);
  const b = await mk('Yaw', 'Boateng', 'Primary 1', 'male', '0244000002'); ok(b, 201);
  const c = await mk('Kwame', 'Asare', 'Primary 1', 'male', '0244000003'); ok(c, 201);
  const d = await mk('Efua', 'Quaye', 'Primary 2', 'female', '0244000004'); ok(d, 201);
  S.st = { abena: a.data.id, yaw: b.data.id, kwame: c.data.id, efua: d.data.id };
  assert.match(a.data.admission_no, /^\d{4}-0001$/);
  assert.equal(a.data.guardians[0].is_primary, 1);

  const list = (await S.admin.get('/api/students?class_id=' + S.classes['Primary 1'])).data;
  assert.equal(list.total, 3);
  assert.equal((await S.admin.get('/api/students?q=abe')).data.total, 1);
  assert.equal((await S.admin.get('/api/students?q=%25')).data.total, 0, 'LIKE wildcards are escaped');

  ok(await S.admin.post('/api/students', { first_name: '', last_name: 'X' }), 400);
  ok(await S.admin.post('/api/students', { first_name: 'A', last_name: 'B', class_id: 99999 }), 400);
  ok(await S.admin.post('/api/students', { first_name: 'A', last_name: 'B', dob: '2999-01-01' }), 400);
  ok(await S.admin.post('/api/students', { first_name: 'A', last_name: 'B', admission_no: a.data.admission_no }), 409);

  const upd = await S.admin.put(`/api/students/${S.st.abena}`, { first_name: 'Abena', last_name: 'Owusu-Ansah', class_id: S.classes['Primary 1'], gender: 'female' });
  ok(upd); assert.equal(upd.data.last_name, 'Owusu-Ansah');
  assert.equal(upd.data.guardians.length, 1, 'guardians untouched when omitted');
});

test('teacher scoping: own class attendance only; results only for assigned subject', async () => {
  const p1 = S.classes['Primary 1']; const p2 = S.classes['Primary 2'];
  ok(await S.admin.put(`/api/classes/${p1}`, { name: 'Primary 1', teacher_id: S.teacherId }));
  ok(await S.admin.put(`/api/classes/${p2}`, { name: 'Primary 2', teacher_id: S.teacher2Id }));
  const roster = await S.teacher.get(`/api/attendance?class_id=${p1}&date=2026-09-15`);
  ok(roster); assert.equal(roster.data.records.length, 3);
  ok(await S.teacher.get(`/api/attendance?class_id=${p2}`), 403);

  const save = await S.teacher.put('/api/attendance', { class_id: p1, date: '2026-09-15',
    records: [{ student_id: S.st.abena, status: 'present' }, { student_id: S.st.yaw, status: 'late' }, { student_id: S.st.kwame, status: 'absent' }] });
  ok(save); assert.equal(save.data.saved, 3);
  ok(await S.teacher.put('/api/attendance', { class_id: p1, date: '2999-01-01', records: [{ student_id: S.st.abena, status: 'present' }] }), 400);
  ok(await S.teacher.put('/api/attendance', { class_id: p1, date: '2026-09-15', records: [{ student_id: S.st.efua, status: 'present' }] }), 400);
  const rep = (await S.teacher.get(`/api/attendance/report?class_id=${p1}&from=2026-09-01&to=2026-09-30`)).data;
  assert.equal(rep.students.find((s) => s.student_id === S.st.abena).rate, 100);
  assert.equal(rep.students.find((s) => s.student_id === S.st.kwame).rate, 0);
});

test('results: CA + exam, validation, positions, grades, remarks, class summary', async () => {
  const p1 = S.classes['Primary 1'];
  const maths = S.subjects.Mathematics; const eng = S.subjects['English Language'];
  ok(await S.admin.put(`/api/classes/${p1}/subjects`, { assignments: [{ subject_id: maths, teacher_id: S.teacherId }, { subject_id: eng, teacher_id: S.teacher2Id }] }));

  const enter = (subject, rows) => S.teacher.put('/api/results', { class_id: p1, subject_id: subject, term: 1, records: rows });
  // a teacher who is neither class teacher nor assigned to the subject cannot enter scores
  const other = client();
  const rs = await S.admin.post(`/api/staff/${S.teacher2Id}/reset-password`);
  ok(await other.post('/api/auth/login', { email: 'esi@greenfield.test', password: rs.data.temporary_password }));
  ok(await other.put('/api/results', { class_id: p1, subject_id: maths, term: 1, records: [{ student_id: S.st.abena, ca_score: 20, exam_score: 50 }] }), 403);
  ok(await enter(maths, [{ student_id: S.st.abena, ca_score: 31, exam_score: 50 }]), 400); // CA max is 30
  ok(await enter(maths, [{ student_id: S.st.abena, ca_score: 20, exam_score: 71 }]), 400); // exam max is 70
  ok(await enter(maths, [
    { student_id: S.st.abena, ca_score: 28, exam_score: 62 }, // 90
    { student_id: S.st.yaw, ca_score: 20, exam_score: 55 },   // 75
    { student_id: S.st.kwame, ca_score: 20, exam_score: 55 }, // 75 (tie)
  ]));
  // English entered by the other teacher
  const t2 = other; // Esi is assigned to English for Primary 1
  ok(await t2.put('/api/results', { class_id: p1, subject_id: eng, term: 1, records: [
    { student_id: S.st.abena, ca_score: 25, exam_score: 50 }, // 75
    { student_id: S.st.yaw, ca_score: 10, exam_score: 30 },   // 40
    { student_id: S.st.kwame, ca_score: 22, exam_score: 60 }, // 82
  ] }));

  const card = (await S.admin.get(`/api/students/${S.st.abena}/report?term=1`)).data;
  const m = card.subjects.find((s) => s.subject === 'Mathematics');
  assert.equal(m.total, 90); assert.equal(m.grade, 'A'); assert.equal(m.position, 1); assert.equal(m.out_of, 3);
  assert.equal(card.overall.total, 165); assert.equal(card.overall.average, 82.5);
  assert.equal(card.overall.position, 1);
  const yaw = (await S.admin.get(`/api/students/${S.st.yaw}/report?term=1`)).data;
  const ym = yaw.subjects.find((s) => s.subject === 'Mathematics');
  assert.equal(ym.position, 2, 'tied students share a position');
  assert.equal((await S.admin.get(`/api/students/${S.st.kwame}/report?term=1`)).data.subjects.find((s) => s.subject === 'Mathematics').position, 2);
  assert.match(card.verification_code, /^SF-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  S.verifyCode = card.verification_code;

  // remarks: class teacher can write theirs but not the head's
  ok(await S.teacher.put(`/api/students/${S.st.abena}/report-meta`, { term: 1, teacher_remark: 'Brilliant term', conduct: 'Excellent' }));
  ok(await S.teacher.put(`/api/students/${S.st.abena}/report-meta`, { term: 1, head_remark: 'x' }), 403);
  ok(await S.admin.put(`/api/students/${S.st.abena}/report-meta`, { term: 1, head_remark: 'Keep it up' }));
  const card2 = (await S.admin.get(`/api/students/${S.st.abena}/report?term=1`)).data;
  assert.equal(card2.meta.teacher_remark, 'Brilliant term'); assert.equal(card2.meta.head_remark, 'Keep it up');

  const summary = (await S.teacher.get(`/api/reports/class?class_id=${p1}&term=1`)).data;
  assert.equal(summary.students[0].name, 'Abena Owusu-Ansah');
  assert.equal(summary.out_of, 3);
});

test('publishing controls parent access; published results are locked', async () => {
  const p1 = S.classes['Primary 1'];
  // parent account for Abena
  const grant = await S.admin.post(`/api/students/${S.st.abena}/portal`, { name: 'Mrs Owusu', email: 'owusu.parent@mail.test', phone: '0244000001' });
  ok(grant, 201);
  S.parent = client();
  const login = await S.parent.post('/api/auth/login', { email: 'owusu.parent@mail.test', password: grant.data.temporary_password });
  ok(login); assert.equal(login.data.user.role, 'parent');
  assert.deepEqual(login.data.permissions.sort(), ['messages:use', 'portal:read']);

  // sibling shares the same login
  const sib = await S.admin.post(`/api/students/${S.st.efua}/portal`, { email: 'owusu.parent@mail.test' });
  ok(sib, 201); assert.equal(sib.data.linked_existing, true);
  const kids = (await S.parent.get('/api/portal/children')).data;
  assert.deepEqual(kids.map((k) => k.first_name).sort(), ['Abena', 'Efua']);

  // strict isolation: a parent cannot reach other children or staff endpoints
  ok(await S.parent.get(`/api/portal/children/${S.st.yaw}`), 404);
  ok(await S.parent.get(`/api/students/${S.st.abena}`), 403);
  ok(await S.parent.get('/api/students'), 403);
  ok(await S.parent.get(`/api/students/${S.st.abena}/report?term=1`), 403);

  // not released yet
  ok(await S.parent.get(`/api/portal/children/${S.st.abena}/report?term=1`), 403);
  ok(await S.teacher.post('/api/reports/publish', { class_id: p1, term: 1 }), 403);
  ok(await S.admin.post('/api/reports/publish', { class_id: p1, term: 1 }));
  const card = await S.parent.get(`/api/portal/children/${S.st.abena}/report?term=1`);
  ok(card); assert.equal(card.data.overall.average, 82.5);
  assert.equal((await S.parent.get(`/api/portal/children/${S.st.abena}`)).data.reports.length, 1);

  // locked while published
  ok(await S.teacher.put('/api/results', { class_id: p1, subject_id: S.subjects.Mathematics, term: 1, records: [{ student_id: S.st.abena, ca_score: 1, exam_score: 1 }] }), 409);
  ok(await S.admin.post('/api/reports/publish', { class_id: p1, term: 1, publish: false }));
  ok(await S.admin.post('/api/reports/publish', { class_id: p1, term: 1 }));
});

test('public verification of a report card', async () => {
  const anon = client();
  const good = await anon.get(`/api/verify?code=${S.verifyCode}`);
  ok(good); assert.equal(good.data.valid, true); assert.equal(good.data.student, 'Abena Owusu-Ansah'); assert.equal(good.data.position, 1);
  assert.equal((await anon.get('/api/verify?code=SF-ZZZZ-ZZZZ')).data.valid, false);
  assert.equal((await anon.get('/api/verify?code=garbage')).data.valid, false);
});

test('fees: bulk billing, no double billing, overpayment blocked, receipts, balances, reminders', async () => {
  const bill = await S.accountant.post('/api/invoices', { description: 'School fees', amount: 50000, term: 1, class_id: S.classes['Primary 1'], due_date: '2026-01-01' });
  ok(bill, 201); assert.equal(bill.data.created, 3);
  const again = await S.accountant.post('/api/invoices', { description: 'School fees', amount: 50000, term: 1, class_id: S.classes['Primary 1'] });
  assert.equal(again.data.created, 0); assert.equal(again.data.skipped, 3);

  const inv = (await S.accountant.get(`/api/invoices?student_id=${S.st.abena}`)).data.items[0];
  assert.equal(inv.balance, 50000);
  ok(await S.accountant.post('/api/payments', { invoice_id: inv.id, amount: 60000, method: 'cash' }), 400);
  ok(await S.accountant.post('/api/payments', { invoice_id: inv.id, amount: 0, method: 'cash' }), 400);
  ok(await S.accountant.post('/api/payments', { invoice_id: inv.id, amount: 100, method: 'bitcoin' }), 400);
  const pay = await S.accountant.post('/api/payments', { invoice_id: inv.id, amount: 20000, method: 'momo', reference: 'MP123' });
  ok(pay, 201); assert.match(pay.data.receipt_no, /^RCT-\d{4}-00001$/); assert.equal(pay.data.balance_after, 30000);
  const pay2 = await S.accountant.post('/api/payments', { invoice_id: inv.id, amount: 30000, method: 'cash' });
  ok(pay2, 201); assert.match(pay2.data.receipt_no, /-00002$/);
  ok(await S.accountant.post('/api/payments', { invoice_id: inv.id, amount: 1, method: 'cash' }), 409);

  const sum = (await S.accountant.get('/api/fees/summary')).data;
  assert.equal(sum.billed, 150000); assert.equal(sum.collected, 50000); assert.equal(sum.students_owing, 2);
  assert.equal((await S.accountant.get('/api/invoices?status=outstanding')).data.total, 2);
  assert.equal((await S.accountant.get('/api/invoices?status=overdue')).data.total, 2);
  assert.equal((await S.accountant.get('/api/invoices?status=paid')).data.total, 1);

  // teachers never see money
  const list = (await S.teacher.get('/api/students')).data.items;
  assert.ok(list.every((s) => !('balance' in s)));
  ok(await S.teacher.get('/api/invoices'), 403);

  const rem = (await S.accountant.post('/api/fees/remind', { overdue_only: true })).data;
  assert.equal(rem.students_with_balance, 2); assert.equal(rem.queued, 2);
  const parentSees = (await S.parent.get(`/api/portal/children/${S.st.abena}`)).data.fees;
  assert.equal(parentSees.balance, 0); assert.equal(parentSees.payments.length, 2);
});

test('SMS/email outbox: queued, processed via dev-log provider, visible to admin', async () => {
  const before = (await S.admin.get('/api/notifications')).data;
  assert.ok(before.counts.queued >= 4);
  const p = (await S.admin.post('/api/notifications/process')).data;
  assert.ok(p.processed >= 4);
  const after = (await S.admin.get('/api/notifications')).data;
  assert.equal(after.counts.queued ?? 0, 0);
  assert.ok(after.items.every((n) => n.channel === 'sms' || n.channel === 'email'));
  assert.ok(after.items.some((n) => /GH₵/.test(n.body)));
  assert.ok(after.items.some((n) => n.recipient.startsWith('+233')), 'Ghana numbers normalised to E.164');
});

test('announcements (class-scoped for teachers), events, tasks', async () => {
  const p1 = S.classes['Primary 1']; const p2 = S.classes['Primary 2'];
  ok(await S.teacher.post('/api/announcements', { title: 'Hi', body: 'All school' }), 403);
  ok(await S.teacher.post('/api/announcements', { title: 'Hi', body: 'x', class_id: p2 }), 403);
  const own = await S.teacher.post('/api/announcements', { title: 'Trip', body: 'Bring lunch', class_id: p1, notify: ['sms'] });
  ok(own, 201); assert.equal(own.data.queued.sms, 3);
  const all = await S.admin.post('/api/announcements', { title: 'PTA meeting', body: 'Friday 4pm', audience: 'all', notify: ['email'] });
  ok(all, 201); assert.ok(all.data.queued.email >= 4);

  const feed = (await S.parent.get('/api/portal/feed')).data;
  assert.ok(feed.announcements.some((a) => a.title === 'PTA meeting'));
  assert.ok(feed.announcements.some((a) => a.title === 'Trip'));

  ok(await S.admin.post('/api/events', { title: 'Sports day', start_date: '2999-03-01', end_date: '2999-02-01' }), 400);
  ok(await S.admin.post('/api/events', { title: 'Sports day', start_date: '2999-03-01', location: 'Park' }), 201);
  assert.equal((await S.parent.get('/api/portal/feed')).data.events.length, 1);

  const task = await S.admin.post('/api/tasks', { title: 'Submit lesson plans', assigned_to: S.teacherId, due_date: '2020-01-01' });
  ok(task, 201);
  const mine = (await S.teacher.get('/api/tasks')).data;
  assert.equal(mine.length, 1); assert.equal(mine[0].overdue, true);
  ok(await S.teacher.post('/api/tasks', { title: 'x', assigned_to: S.teacherId }), 403);
  ok(await S.teacher.put(`/api/tasks/${task.data.id}/status`, { status: 'done' }));
  ok(await S.accountant.get('/api/tasks'), 403);
  assert.equal((await S.admin.get('/api/tasks')).data[0].status, 'done');
});

test('messages: parents can message staff, not each other; unread counts', async () => {
  const contacts = (await S.parent.get('/api/messages/contacts')).data;
  assert.ok(contacts.every((c) => c.role !== 'parent'));
  ok(await S.parent.post('/api/messages', { to_user_id: S.teacherId, body: 'Is Abena improving?' }), 201);
  assert.equal((await S.teacher.get('/api/messages/unread')).data.unread, 1);
  const thread = (await S.teacher.get(`/api/messages/with/${(await S.parent.get('/api/me')).data.user.id}`)).data;
  assert.equal(thread.messages.length, 1);
  assert.equal((await S.teacher.get('/api/messages/unread')).data.unread, 0);
  const parentId = thread.user.id;
  ok(await S.teacher.post('/api/messages', { to_user_id: parentId, body: 'Yes, doing great!' }), 201);
  assert.equal((await S.parent.get('/api/messages/threads')).data[0].unread, 1);
  // second parent
  const g2 = await S.admin.post(`/api/students/${S.st.yaw}/portal`, { name: 'Mr Boateng', email: 'boateng@mail.test' });
  const p2 = client(); ok(await p2.post('/api/auth/login', { email: 'boateng@mail.test', password: g2.data.temporary_password }));
  ok(await p2.post('/api/messages', { to_user_id: parentId, body: 'hello' }), 403);
});

test('timetable clash detection', async () => {
  const p1 = S.classes['Primary 1']; const p2 = S.classes['Primary 2'];
  const base = { class_id: p1, subject_id: S.subjects.Mathematics, teacher_id: S.teacherId, day: 1, start_time: '08:00', end_time: '09:00' };
  ok(await S.admin.post('/api/timetable', base), 201);
  ok(await S.admin.post('/api/timetable', { ...base, teacher_id: null }), 409); // class already busy
  ok(await S.admin.post('/api/timetable', { ...base, class_id: p2, start_time: '08:30', end_time: '09:30' }), 409); // teacher already busy
  ok(await S.admin.post('/api/timetable', { ...base, class_id: p2, start_time: '09:00', end_time: '10:00' }), 201); // back-to-back is fine
  ok(await S.admin.post('/api/timetable', { ...base, start_time: '10:00', end_time: '09:00' }), 400);
  ok(await S.admin.post('/api/timetable', { ...base, start_time: '8am' }), 400);
  assert.equal((await S.teacher.get(`/api/timetable?teacher_id=${S.teacherId}`)).data.length, 2);
  assert.equal((await S.parent.get(`/api/portal/children/${S.st.abena}/timetable`)).data.length, 1);
});

test('online admissions: public form, honeypot, admit into a class', async () => {
  const anon = client();
  const info = await anon.get('/api/public/school?school=greenfield-academy');
  ok(info); assert.equal(info.data.name, 'Greenfield Academy'); assert.ok(!('id' in info.data)); assert.ok(info.data.classes.length >= 4);
  ok(await anon.get('/api/public/school?school=nope'), 404);
  ok(await anon.post('/api/public/apply', { school: 'greenfield-academy', first_name: 'Ama', last_name: 'Newcomer', guardian_name: 'Kojo' }), 400); // no contact
  const bot = await anon.post('/api/public/apply', { school: 'greenfield-academy', first_name: 'Bot', last_name: 'Bot', guardian_name: 'x', guardian_phone: '0244000009', website: 'spam.example' });
  assert.equal(bot.data.application_no, 'APP-RECEIVED');
  const res = await anon.post('/api/public/apply', { school: 'greenfield-academy', first_name: 'Nana', last_name: 'Newcomer', gender: 'female', dob: '2019-02-02', class_id: S.classes.KG,
    guardian_name: 'Kojo Newcomer', guardian_phone: '024 400 0010', guardian_email: 'kojo@mail.test' });
  ok(res, 201); assert.match(res.data.application_no, /^APP-\d{4}-0001$/);
  const apps = (await S.admin.get('/api/students?status=applicant')).data;
  assert.equal(apps.total, 1, 'honeypot submissions are not stored');
  const admitted = await S.admin.post(`/api/students/${apps.items[0].id}/admit`, { class_id: S.classes.KG });
  ok(admitted); assert.equal(admitted.data.status, 'active'); assert.doesNotMatch(admitted.data.admission_no, /^APP/);
  ok(await S.admin.post(`/api/students/${apps.items[0].id}/admit`, { class_id: S.classes.KG }), 400);
});

test('promotion: class moves up, graduation clears class', async () => {
  const r1 = await S.admin.post('/api/promotions', { from_class_id: S.classes.KG, to_class_id: S.classes['Primary 1'], action: 'promote' });
  ok(r1); assert.equal(r1.data.moved, 1);
  ok(await S.admin.post('/api/promotions', { from_class_id: S.classes.KG, to_class_id: S.classes.KG, action: 'promote' }), 400);
  ok(await S.admin.post('/api/promotions', { from_class_id: S.classes['Primary 3'], action: 'graduate' }), 400); // empty class
  const g = await S.admin.post('/api/promotions', { from_class_id: S.classes['Primary 2'], action: 'graduate' });
  ok(g); assert.equal(g.data.moved, 1);
  const efua = (await S.admin.get(`/api/students/${S.st.efua}`)).data;
  assert.equal(efua.status, 'graduated'); assert.equal(efua.class_id, null);
});

test('dashboard, reports, settings, audit log, CSV export', async () => {
  const d = (await S.admin.get('/api/dashboard')).data;
  assert.ok(d.students >= 3); assert.equal(d.fees.billed, 150000); assert.ok(d.recent.length > 0);
  assert.ok(d.recent.every((x) => !x.action.startsWith('auth.')));
  const td = (await S.teacher.get('/api/dashboard')).data;
  assert.ok(!('fees' in td) && !('recent' in td)); assert.equal(td.my_classes.length, 1);
  const rep = (await S.admin.get('/api/reports/overview')).data;
  assert.ok(rep.subject_averages.length >= 2); assert.ok(rep.grade_distribution.some((g) => g.count > 0));
  ok(await S.teacher.get('/api/reports/overview'), 403);

  const set = await S.admin.put('/api/settings', { motto: 'New motto', ca_max: 40, grading_scale: [{ min: 50, grade: 'P', remark: 'Pass' }, { min: 0, grade: 'F', remark: 'Fail' }], current_term: 2 });
  ok(set); assert.equal(set.data.exam_max, 60); assert.equal(set.data.current_term, 2);
  ok(await S.admin.put('/api/settings', { grading_scale: [{ min: 50, grade: 'P' }] }), 400);
  ok(await S.admin.put('/api/settings', { primary_color: 'red' }), 400);
  ok(await S.admin.put('/api/terms', { term: 2, start_date: '2026-09-01', end_date: '2026-12-15', next_term_begins: '2027-01-10' }));
  ok(await S.admin.put('/api/settings', { ca_max: 30, current_term: 1, grading_scale: [{ min: 80, grade: 'A' }, { min: 0, grade: 'F' }] }));

  const audit = (await S.admin.get('/api/audit')).data;
  assert.ok(audit.total > 20);
  ok(await S.teacher.get('/api/audit'), 403);

  const csv = await S.admin.get('/api/export/students.csv');
  ok(csv); assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.data, /admission_no,first_name/);
  ok(await S.teacher.get('/api/export/students.csv'), 403);
  const all = await S.admin.get('/api/export/all');
  ok(all); assert.ok(all.data.students.length >= 5); assert.ok(!JSON.stringify(all.data).includes('password_hash'));
});

test('CSV export neutralises spreadsheet formulas', async () => {
  ok(await S.admin.post('/api/students', { first_name: '=HYPERLINK("http://evil")', last_name: 'Test' }), 201);
  const csv = (await S.admin.get('/api/export/students.csv')).data;
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`), 'leading = is neutralised');
});

test('multi-tenancy: another school sees none of this data', async () => {
  const other = client();
  ok(await other.post('/api/schools', { admin: { name: 'Bob', email: 'bob@other.test', password: 'another-pass-1' }, school: { name: 'Greenfield Academy', levels: 'Class 1–2' } }), 201);
  assert.equal((await other.get('/api/me')).data.school.slug, 'greenfield-academy-2', 'slug collision handled');
  assert.equal((await other.get('/api/students')).data.total, 0);
  ok(await other.get(`/api/students/${S.st.abena}`), 404);
  ok(await other.put(`/api/students/${S.st.abena}`, { first_name: 'x', last_name: 'y' }), 404);
  ok(await other.get(`/api/students/${S.st.abena}/report`), 404);
  ok(await other.post('/api/payments', { invoice_id: 1, amount: 1, method: 'cash' }), 404);
  ok(await other.put(`/api/classes/${S.classes.KG}`, { name: 'Hijack' }), 404);
  ok(await other.put(`/api/classes/${(await other.get('/api/classes')).data[0].id}`, { name: 'Mine', teacher_id: S.teacherId }), 400); // cannot assign another school's staff
  assert.equal((await other.get('/api/invoices')).data.total, 0);
  assert.equal((await other.get('/api/staff')).data.length, 1);
  assert.equal((await other.get('/api/audit')).data.items.every((a) => !/Abena|Greenfield.*fees/.test(a.summary || '')), true);
  ok(await other.post(`/api/students/${S.st.abena}/portal`, { name: 'x', email: 'evil@x.test' }), 404);
  ok(await other.get(`/api/messages/with/${S.teacherId}`), 404);
  ok(await other.post('/api/messages', { to_user_id: S.teacherId, body: 'hi' }), 400);
});

test('sessions: logout invalidates, deactivation signs staff out, login rate-limited', async () => {
  const c = client();
  ok(await c.post('/api/auth/login', { email: 'ama@greenfield.test', password: 'correct-horse-9' }));
  ok(await c.get('/api/me'));
  ok(await c.post('/api/auth/logout'), 204);
  ok(await c.get('/api/me'), 401);

  ok(await S.admin.put(`/api/staff/${S.accountantId ?? (await S.admin.get('/api/staff')).data.find((s) => s.role === 'accountant').id}`, { active: false }));
  ok(await S.accountant.get('/api/me'), 401);
  const adminRow = (await S.admin.get('/api/staff')).data.find((s) => s.role === 'admin');
  ok(await S.admin.put(`/api/staff/${adminRow.id}`, { active: false }), 400);

  const brute = client();
  for (let i = 0; i < 8; i++) ok(await brute.post('/api/auth/login', { email: 'kofi@greenfield.test', password: `bad${i}` }), 401);
  ok(await brute.post('/api/auth/login', { email: 'kofi@greenfield.test', password: 'brand-new-pass1' }), 429);
});

test('static files served safely', async () => {
  const idx = await fetch(`${base}/`);
  assert.equal(idx.status, 200);
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/..%2f..%2fserver%2fdb.js`)).status >= 400, true);
  assert.equal((await fetch(`${base}/%2e%2e/server/db.js`)).status >= 400, true);
  assert.equal((await fetch(`${base}/nonexistent.html`)).status, 404);
});
