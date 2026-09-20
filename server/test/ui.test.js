'use strict';
// Executes public/js/*.js (the real dashboard shell + every view) in a sandbox with a minimal fake DOM,
// talking to a real server instance. It cannot judge visual layout, but it catches runtime errors,
// bad template variables, wrong API paths and permission/nav mistakes for every role.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../db');
const { createApp } = require('../app');

const PUB = path.join(__dirname, '..', '..', 'public');
const SCRIPTS = ['api', 'ui', 'v-dashboard', 'v-students', 'v-academics', 'v-attendance', 'v-results', 'v-fees', 'v-timetable', 'v-comms', 'v-messages', 'v-staff', 'v-reports', 'v-settings', 'v-portal', 'core']
  .map((n) => path.join(PUB, 'js', `${n}.js`));

let base; let app;
const problems = [];
process.on('unhandledRejection', (e) => problems.push(`unhandledRejection: ${e && e.stack || e}`));

/* ---------------- fake DOM ---------------- */
function makeEl(name = 'el') {
  const store = { innerHTML: '', textContent: '', value: '', checked: false, disabled: false, hidden: false, className: '', dataset: {}, style: {}, files: [], scrollTop: 0, scrollHeight: 0 };
  const cache = new Map(); const handlers = {};
  const el = new Proxy(store, {
    get(t, p) {
      if (p in t) return t[p];
      switch (p) {
        case '__cache': return cache;
        case '__handlers': return handlers;
        case 'querySelector': return (sel) => { if (!cache.has(sel)) cache.set(sel, makeEl(sel)); return cache.get(sel); };
        case 'querySelectorAll': return () => [];
        case 'addEventListener': return (type, fn) => { (handlers[type] ||= []).push(fn); };
        case 'removeEventListener': case 'focus': case 'remove': case 'append': case 'appendChild': case 'setAttribute': case 'replaceChildren': case 'reportValidity': case 'setCustomValidity': case 'select': case 'click':
          return () => {};
        case 'contains': return () => true;
        case 'closest': return () => el;
        case 'checkValidity': return () => true;
        case 'classList': return { add() {}, remove() {}, toggle() {}, contains: () => false };
        default: return undefined;
      }
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  return el;
}
const flatten = (el) => { let s = el.innerHTML || ''; for (const c of el.__cache.values()) s += flatten(c); return s; };

function makeSandbox(cookieJar) {
  const byId = new Map();
  const winHandlers = {};
  let pending = 0;
  const location = { hash: '', origin: 'http://school.test', search: '', href: '', replaced: null, replace(u) { this.replaced = u; } };
  const document = {
    getElementById: (id) => { if (!byId.has(id)) byId.set(id, makeEl(id)); return byId.get(id); },
    createElement: () => makeEl('created'), querySelector: () => makeEl(), querySelectorAll: () => [],
    body: makeEl('body'), documentElement: { style: { setProperty() {} } }, addEventListener() {}, removeEventListener() {}, title: '',
  };
  const store = new Map();
  const session = new Map();
  const sandbox = {
    document, location, console, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Intl, Promise,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    sessionStorage: { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k), get length() { return session.size; }, key: (i) => [...session.keys()][i] ?? null },
    navigator: {}, FormData: class {}, Image: class {},
    fetch: async (p, opts = {}) => {
      pending++;
      try {
        const res = await fetch(base + p, { ...opts, headers: { ...(opts.headers || {}), ...(cookieJar.value ? { Cookie: cookieJar.value } : {}) } });
        const set = res.headers.getSetCookie?.()[0];
        if (set) cookieJar.value = set.split(';')[0];
        return res;
      } finally { pending--; }
    },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (type, fn) => { (winHandlers[type] ||= []).push(fn); };
  sandbox.window.scrollTo = () => {}; sandbox.window.print = () => {};
  vm.createContext(sandbox);

  const settle = async () => {
    let quiet = 0;
    for (let i = 0; i < 300 && quiet < 4; i++) { await new Promise((r) => setTimeout(r, 15)); quiet = pending === 0 ? quiet + 1 : 0; }
  };
  return {
    sandbox, document, location, settle,
    load() { for (const f of SCRIPTS) vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: path.basename(f) }); },
    async go(hash) { location.hash = hash; for (const fn of winHandlers.hashchange || []) fn(); await settle(); },
    view: () => flatten(document.getElementById('view')),
    nav: () => flatten(document.getElementById('nav')),
    tabbar: () => flatten(document.getElementById('tabbar')),
    header: () => document.getElementById('pageTitle').textContent,
  };
}

async function open(cookieJar, hash) {
  const sb = makeSandbox(cookieJar);
  sb.location.hash = hash;
  sb.load();
  await sb.settle();
  return sb;
}

/* ---------------- seed real data through the API ---------------- */
const S = {};
async function call(jar, method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(jar.value ? { Cookie: jar.value } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie?.()[0]; if (set) jar.value = set.split(';')[0];
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text}`);
  return data;
}

test.before(async () => {
  const db = openDb(':memory:');
  app = createApp(db, { notifyIntervalMs: 0, logger: { log() {}, error() {} }, registerLimit: 100 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;

  S.admin = { value: '' };
  await call(S.admin, 'POST', '/api/schools', { admin: { name: 'Ama Mensah', email: 'ama@ui.test', phone: '0241234567', password: 'password-123' },
    school: { name: 'Greenfield Academy', motto: 'Learn & Lead', levels: 'KG, Primary 1–2', academic_year: '2026/2027', terms: '3 Terms' } });
  const classes = await call(S.admin, 'GET', '/api/classes'); S.cls = Object.fromEntries(classes.map((c) => [c.name, c.id]));
  const subjects = await call(S.admin, 'GET', '/api/subjects'); S.sub = Object.fromEntries(subjects.map((s) => [s.name, s.id]));

  const t = await call(S.admin, 'POST', '/api/staff', { name: 'Kofi Teacher', email: 'kofi@ui.test', phone: '0201112222', role: 'teacher' });
  S.teacherId = t.staff.id; S.teacher = { value: '' };
  await call(S.teacher, 'POST', '/api/auth/login', { email: 'kofi@ui.test', password: t.temporary_password });
  await call(S.teacher, 'POST', '/api/auth/change-password', { current_password: t.temporary_password, new_password: 'teacher-pass-1' });
  const a = await call(S.admin, 'POST', '/api/staff', { name: 'Yaw Bursar', email: 'yaw@ui.test', role: 'accountant' });
  S.accountant = { value: '' };
  await call(S.accountant, 'POST', '/api/auth/login', { email: 'yaw@ui.test', password: a.temporary_password });
  await call(S.admin, 'PUT', `/api/classes/${S.cls['Primary 1']}`, { name: 'Primary 1', teacher_id: S.teacherId });
  await call(S.admin, 'PUT', `/api/classes/${S.cls['Primary 1']}/subjects`, { assignments: [{ subject_id: S.sub.Mathematics, teacher_id: S.teacherId }] });

  S.st = [];
  for (const [f, l, g] of [['Abena', 'Owusu', 'female'], ['Yaw', 'Boateng', 'male'], ['Kwame', 'Asare', 'male']]) {
    const s = await call(S.admin, 'POST', '/api/students', { first_name: f, last_name: l, gender: g, dob: '2018-05-01', class_id: S.cls['Primary 1'], address: 'Tamale',
      guardians: [{ name: `${f}'s parent`, relationship: 'Mother', phone: '0244000001', email: `${f.toLowerCase()}@parent.test` }] });
    S.st.push(s.id);
  }
  await call(S.teacher, 'PUT', '/api/attendance', { class_id: S.cls['Primary 1'], date: new Date().toISOString().slice(0, 10), records: S.st.map((id, i) => ({ student_id: id, status: ['present', 'late', 'absent'][i] })) });
  await call(S.teacher, 'PUT', '/api/results', { class_id: S.cls['Primary 1'], subject_id: S.sub.Mathematics, term: 1, records: [
    { student_id: S.st[0], ca_score: 28, exam_score: 60 }, { student_id: S.st[1], ca_score: 20, exam_score: 50 }, { student_id: S.st[2], ca_score: 10, exam_score: 30 }] });
  await call(S.admin, 'POST', '/api/invoices', { description: 'School fees', amount: 85000, term: 1, due_date: '2020-01-01' });
  const inv = await call(S.admin, 'GET', `/api/invoices?student_id=${S.st[0]}`);
  await call(S.admin, 'POST', '/api/payments', { invoice_id: inv.items[0].id, amount: 40000, method: 'momo', reference: 'MP1' });
  await call(S.admin, 'POST', '/api/announcements', { title: 'PTA meeting', body: 'Friday at 4pm', notify: ['sms'] });
  await call(S.admin, 'POST', '/api/events', { title: 'Sports day', start_date: '2999-03-01', location: 'Park' });
  await call(S.admin, 'POST', '/api/tasks', { title: 'Submit lesson plans', assigned_to: S.teacherId, due_date: '2020-01-01' });
  await call(S.admin, 'POST', '/api/timetable', { class_id: S.cls['Primary 1'], subject_id: S.sub.Mathematics, teacher_id: S.teacherId, day: 1, start_time: '08:00', end_time: '09:00', room: 'Room 1' });
  await call(S.admin, 'POST', '/api/reports/publish', { class_id: S.cls['Primary 1'], term: 1 });
  const p = await call(S.admin, 'POST', `/api/students/${S.st[0]}/portal`, { name: 'Mrs Owusu', email: 'owusu@parent.test', phone: '0244000001' });
  S.parent = { value: '' };
  await call(S.parent, 'POST', '/api/auth/login', { email: 'owusu@parent.test', password: p.temporary_password });
  await call(S.parent, 'POST', '/api/messages', { to_user_id: S.teacherId, body: 'How is Abena doing?' });
  await call(S.admin, 'POST', '/api/public/apply', { school: 'greenfield-academy', first_name: 'Nana', last_name: 'Newcomer', guardian_name: 'Kojo', guardian_phone: '0244000010' });
  await app.svc.notifier.processQueue(100);
});
test.after(() => { app.server.close(); });

const noError = (sb, label) => {
  const v = sb.view();
  assert.ok(!v.includes('id="retry"'), `${label} rendered an error panel: ${v.replace(/<[^>]+>/g, ' ').slice(0, 200)}`);
};

/* ---------------- admin: every view renders with real data ---------------- */
test('admin: shell, navigation and dashboard', async () => {
  const sb = await open(S.admin, '#/dashboard');
  noError(sb, 'dashboard');
  const nav = sb.nav();
  for (const label of ['Dashboard', 'Students', 'Academics', 'Attendance', 'Exams &amp; Results', 'Fees &amp; Finance', 'Timetable', 'Communication', 'Messages', 'Staff &amp; HR', 'Reports &amp; Analytics', 'Settings']) assert.ok(nav.includes(label), `nav has ${label}`);
  const v = sb.view();
  assert.match(v, /Quick actions/); assert.match(v, /Students/); assert.match(v, /Needs attention/);
  assert.match(v, /admission application awaits review/); assert.match(v, /Sports day/); assert.match(v, /Recent activity/);
  assert.match(sb.header(), /Good (morning|afternoon|evening), Ama/);
});

test('admin: students list, filters, profile', async () => {
  const sb = await open(S.admin, '#/students');
  noError(sb, 'students'); const v = sb.view();
  assert.match(v, /Abena/); assert.match(v, /Yaw/); assert.match(v, /Add student/); assert.match(v, /Promote class/); assert.match(v, /Export CSV/);
  assert.match(v, /GH₵ 450\.00/, 'balance shown');
  await sb.go('#/students?status=applicant'); assert.match(sb.view(), /Nana/);
  await sb.go(`#/students/${S.st[0]}`); noError(sb, 'profile'); const p = sb.view();
  assert.match(p, /Parents & guardians/); assert.match(p, /Abena&#39;s parent/); assert.match(p, /Record payment/); assert.match(p, /Report card/);
  assert.match(p, /Parent portal access/); assert.match(p, /owusu@parent\.test/); assert.match(p, /Attendance/);
  await sb.go('#/students/new'); noError(sb, 'students/new');
  await sb.go('#/students/99999'); assert.match(sb.view(), /not found/i);
});

test('admin: academics, attendance, results (scores + summary), fees (both tabs)', async () => {
  const sb = await open(S.admin, '#/academics');
  noError(sb, 'academics'); assert.match(sb.view(), /Primary 1/); assert.match(sb.view(), /Kofi Teacher/); assert.match(sb.view(), /Mathematics/);
  await sb.go(`#/attendance?class_id=${S.cls['Primary 1']}`); noError(sb, 'attendance'); assert.match(sb.view(), /Save attendance/); assert.match(sb.view(), /Abena/); assert.match(sb.view(), /Mark all present/);
  await sb.go(`#/results?class_id=${S.cls['Primary 1']}`); noError(sb, 'results'); assert.match(sb.view(), /published to parents and locked/); assert.ok(!/Save scores/.test(sb.view())); assert.match(sb.view(), /value="28"/); assert.match(sb.view(), /value="60"/);
  await call(S.admin, 'POST', '/api/reports/publish', { class_id: S.cls['Primary 1'], term: 1, publish: false });
  await sb.go(`#/results?class_id=${S.cls['Primary 1']}`); assert.match(sb.view(), /Save scores/, 'editable once unpublished');
  await call(S.admin, 'POST', '/api/reports/publish', { class_id: S.cls['Primary 1'], term: 1 });
  await sb.go('#/results?tab=summary'); noError(sb, 'results summary'); assert.match(sb.view(), /Publish report cards|Unpublish/); assert.match(sb.view(), /1st/); assert.match(sb.view(), /Report card/);
  await sb.go('#/fees'); noError(sb, 'fees'); assert.match(sb.view(), /Generate invoices/); assert.match(sb.view(), /Record payment/); assert.match(sb.view(), /Overdue/); assert.match(sb.view(), /Send reminders/);
  await sb.go('#/fees?tab=payments'); noError(sb, 'payments'); assert.match(sb.view(), /RCT-\d{4}-00001/); assert.match(sb.view(), /Mobile money/);
});

test('admin: timetable, communication, messages, staff tabs, reports, settings', async () => {
  const sb = await open(S.admin, '#/timetable');
  noError(sb, 'timetable'); assert.match(sb.view(), /Monday/); assert.match(sb.view(), /Add lesson/);
  await sb.go('#/communication'); noError(sb, 'communication'); assert.match(sb.view(), /PTA meeting/);
  await sb.go('#/communication?tab=events'); noError(sb, 'events'); assert.match(sb.view(), /Sports day/); assert.match(sb.view(), /Park/);
  await sb.go('#/messages'); noError(sb, 'messages'); assert.match(sb.view(), /New message/);
  await sb.go('#/staff'); noError(sb, 'staff'); assert.match(sb.view(), /Kofi Teacher/); assert.match(sb.view(), /Add staff/);
  await sb.go('#/staff?tab=tasks'); noError(sb, 'tasks'); assert.match(sb.view(), /Submit lesson plans/); assert.match(sb.view(), /Overdue/);
  await sb.go('#/staff?tab=activity'); noError(sb, 'activity'); assert.match(sb.view(), /Added student|Registered|registered/i);
  await sb.go('#/staff?tab=outbox'); noError(sb, 'outbox'); assert.match(sb.view(), /not delivered/); assert.match(sb.view(), /SMS/);
  await sb.go('#/reports'); noError(sb, 'reports'); assert.match(sb.view(), /Enrollment by class/); assert.match(sb.view(), /Attendance by class/); assert.match(sb.view(), /Grade distribution/); assert.match(sb.view(), /Recent payments/);
  await sb.go('#/settings'); noError(sb, 'settings'); assert.match(sb.view(), /School profile/); assert.match(sb.view(), /Grading scale/); assert.match(sb.view(), /apply\.html\?school=greenfield-academy/); assert.match(sb.view(), /Download all school data/);
});

test('admin: unknown route falls back to the first allowed page', async () => {
  const sb = await open(S.admin, '#/nonsense');
  assert.equal(sb.location.hash, '#/dashboard');
});

/* ---------------- teacher ---------------- */
test('teacher: limited navigation and scoped views', async () => {
  const sb = await open(S.teacher, '#/dashboard');
  noError(sb, 'teacher dashboard');
  const nav = sb.nav();
  assert.ok(nav.includes('Attendance') && nav.includes('Exams &amp; Results') && nav.includes('Timetable') && nav.includes('My tasks'));
  for (const hidden of ['Fees &amp; Finance', 'Settings', 'Reports &amp; Analytics']) assert.ok(!nav.includes(hidden), `nav hides ${hidden}`);
  assert.match(sb.view(), /My classes/); assert.match(sb.view(), /Primary 1/); assert.ok(!/Fees collected/.test(sb.view()));
  await sb.go('#/attendance'); noError(sb, 'teacher attendance'); assert.match(sb.view(), /Save attendance/);
  await sb.go('#/results'); noError(sb, 'teacher results'); assert.match(sb.view(), /value="28"/);
  await sb.go('#/students'); noError(sb, 'teacher students'); assert.ok(!/Fee balance/.test(sb.view()), 'teachers never see fee balances'); assert.ok(!/Add student/.test(sb.view()));
  await sb.go('#/staff'); noError(sb, 'teacher tasks'); assert.match(sb.view(), /Submit lesson plans/); assert.ok(!/Add staff/.test(sb.view()));
  await sb.go('#/timetable'); noError(sb, 'teacher timetable'); assert.match(sb.view(), /Math/i);
  await sb.go('#/messages'); noError(sb, 'teacher messages'); assert.match(sb.view(), /How is Abena doing/);
  await sb.go('#/fees'); assert.equal(sb.location.hash, '#/dashboard', 'teacher is bounced from fees');
});

/* ---------------- accountant ---------------- */
test('accountant: finance pages only', async () => {
  const sb = await open(S.accountant, '#/fees');
  noError(sb, 'accountant fees'); assert.match(sb.view(), /Generate invoices/);
  const nav = sb.nav();
  assert.ok(nav.includes('Fees &amp; Finance') && nav.includes('Reports &amp; Analytics'));
  assert.ok(!nav.includes('Attendance') && !nav.includes('Exams'));
  await sb.go('#/reports'); noError(sb, 'accountant reports'); assert.match(sb.view(), /Fees/); assert.ok(!/Grade distribution/.test(sb.view()));
  await sb.go('#/dashboard'); noError(sb, 'accountant dashboard'); assert.match(sb.view(), /Fees collected/);
});

/* ---------------- parent ---------------- */
test('parent: portal only', async () => {
  const sb = await open(S.parent, '#/children');
  noError(sb, 'parent children');
  const nav = sb.nav();
  assert.ok(nav.includes('My Children') && nav.includes('Announcements') && nav.includes('Messages'));
  assert.ok(!nav.includes('Students') && !nav.includes('Fees &amp;') && !nav.includes('Settings'));
  const v = sb.view();
  assert.match(v, /Attendance this term/); assert.match(v, /Fee balance/); assert.match(v, /GH₵ 450\.00/);
  await sb.go(`#/children/${S.st[0]}`); noError(sb, 'parent child'); assert.match(sb.view(), /Attendance this term/);
  await sb.go('#/feed'); noError(sb, 'parent feed'); assert.match(sb.view(), /PTA meeting/); assert.match(sb.view(), /Sports day/);
  await sb.go('#/messages'); noError(sb, 'parent messages'); assert.match(sb.view(), /Kofi Teacher/);
  await sb.go('#/students'); assert.equal(sb.location.hash, '#/children', 'parent cannot open staff pages');
  await sb.go(`#/children/${S.st[1]}`); assert.match(sb.view(), /not found/i, "another family's child is not reachable");
});


/* ---------------- responsive shell, state persistence, table cards ---------------- */
test('shell: icon+label nav, phone tab bar with More, parent tab bar without', async () => {
  const admin = await open(S.admin, '#/dashboard');
  assert.match(admin.nav(), /class="ico"[^>]*>🏠/); assert.match(admin.nav(), /class="lbl">Dashboard/); assert.match(admin.nav(), /title="Exams &amp; Results"/);
  const bar = admin.tabbar();
  assert.match(bar, /Home/); assert.match(bar, /Students/); assert.match(bar, /id="moreBtn"/, 'admin has more than 5 sections so the bar shows More');
  assert.ok(!/Settings/.test(bar), 'only the first four sections sit on the bar');
  const parent = await open(S.parent, '#/children');
  assert.ok(!/moreBtn/.test(parent.tabbar()), 'parents only have three sections so no More button');
  assert.match(parent.tabbar(), /Children/);
});

test('tables carry data-label + cell wrapper so they can become cards on phones', async () => {
  const sb = await open(S.admin, '#/students');
  assert.match(sb.view(), /<td class="" data-label="Name"><div class="cell">/);
  assert.match(sb.view(), /data-label="Fee balance"/);
});

test('state: filters persist across tab switches and clear on demand', async () => {
  const sb = await open(S.admin, '#/students');
  const view = sb.document.getElementById('view');
  const q = view.querySelector('#q');
  q.value = 'abena';
  for (const fn of q.__handlers.input) fn({ target: q });
  await new Promise((r) => setTimeout(r, 450)); await sb.settle();
  let tbl = flatten(view.querySelector('#tbl'));
  assert.match(tbl, /Abena/); assert.ok(!/Yaw/.test(tbl), 'search filtered the list');
  await sb.go('#/dashboard'); await sb.go('#/students');
  assert.match(sb.view(), /value="abena"/, 'search box restored after switching tabs');
  assert.match(sb.view(), /Clear filters/);
  tbl = flatten(view.querySelector('#tbl'));
  assert.ok(/Abena/.test(tbl) && !/Yaw/.test(tbl), 'filtered list restored too');
  // clear
  for (const fn of view.querySelector('#reset').__handlers.click) fn();
  await sb.settle();
  assert.ok(!/value="abena"/.test(view.innerHTML), 'filters cleared');
  tbl = flatten(view.querySelector('#tbl')); assert.match(tbl, /Yaw/);
  // a different person on the same browser tab starts clean
  const other = await open(S.teacher, '#/students');
  assert.ok(!/Clear filters/.test(other.view()));
});

test('state: fees tab and class selection are remembered', async () => {
  const sb = await open(S.admin, '#/fees?tab=payments');
  assert.match(sb.view(), /RCT-/);
  await sb.go('#/dashboard'); await sb.go('#/fees');
  assert.match(sb.view(), /RCT-/, 'returns to the Payments tab the user was on');
  await sb.go('#/fees?tab=invoices'); assert.match(sb.view(), /Record payment/);
});

test('unauthenticated dashboard redirects to login', async () => {
  const sb = await open({ value: '' }, '#/dashboard');
  assert.equal(sb.location.replaced, 'login.html');
});

test('no unhandled errors were thrown while rendering', () => {
  assert.deepEqual(problems, []);
});
