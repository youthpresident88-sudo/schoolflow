(function () {
  const SF = window.SF;
  const { api, qs } = SF;
  const { html, raw, mount, money, fmtDate, age, cap, table, pager, bindPager, statusBadge, badge, bar, pct, toast, fail, formModal, confirmBox, secretModal, debounce, modal } = SF.ui;

  const STATUSES = ['active', 'applicant', 'graduated', 'transferred', 'withdrawn'];
  const statusOptions = STATUSES.map((s) => ({ value: s, label: cap(s) }));

  function studentForm({ student, classes, onDone }) {
    const g = (student && student.guardians) || [];
    const values = { ...(student || {}),
      g1_name: g[0]?.name, g1_relationship: g[0]?.relationship, g1_phone: g[0]?.phone, g1_email: g[0]?.email,
      g2_name: g[1]?.name, g2_relationship: g[1]?.relationship, g2_phone: g[1]?.phone, g2_email: g[1]?.email };
    formModal({
      title: student ? 'Edit student' : 'Add student', wide: true, values, submitLabel: student ? 'Save changes' : 'Add student',
      fields: [
        { name: 'first_name', label: 'First name', required: true }, { name: 'last_name', label: 'Last name', required: true },
        { name: 'gender', label: 'Gender', type: 'select', placeholder: '—', options: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }] },
        { name: 'dob', label: 'Date of birth', type: 'date', max: SF.ui.todayStr() },
        { name: 'class_id', label: 'Class', type: 'select', placeholder: 'No class yet', options: classes.map((c) => ({ value: c.id, label: c.name })) },
        { name: 'status', label: 'Status', type: 'select', options: statusOptions, default: 'active' },
        { name: 'address', label: 'Address', full: true },
        { name: 'previous_school', label: 'Previous school', full: true },
        { name: 'admission_no', label: 'Admission number', help: 'Leave blank to generate one automatically.', full: true },
        { heading: 'Primary parent / guardian' },
        { name: 'g1_name', label: 'Name' }, { name: 'g1_relationship', label: 'Relationship', placeholder: 'Mother, Father…' },
        { name: 'g1_phone', label: 'Phone', type: 'tel', placeholder: '024 000 0000' }, { name: 'g1_email', label: 'Email', type: 'email' },
        { heading: 'Second parent / guardian (optional)' },
        { name: 'g2_name', label: 'Name' }, { name: 'g2_relationship', label: 'Relationship' },
        { name: 'g2_phone', label: 'Phone', type: 'tel' }, { name: 'g2_email', label: 'Email', type: 'email' },
      ],
      onSubmit: async (d) => {
        const guardians = [];
        if (d.g1_name) guardians.push({ name: d.g1_name, relationship: d.g1_relationship, phone: d.g1_phone, email: d.g1_email, is_primary: true });
        if (d.g2_name) guardians.push({ name: d.g2_name, relationship: d.g2_relationship, phone: d.g2_phone, email: d.g2_email, is_primary: false });
        const body = { first_name: d.first_name, last_name: d.last_name, gender: d.gender, dob: d.dob, class_id: d.class_id, status: d.status,
          address: d.address, previous_school: d.previous_school, admission_no: d.admission_no, guardians };
        const saved = student ? await api('PUT', `/api/students/${student.id}`, body) : await api('POST', '/api/students', body);
        toast(student ? 'Student updated' : `Added ${saved.first_name} ${saved.last_name} (${saved.admission_no})`);
        onDone(saved);
      },
    });
  }

  function promoteModal(classes, onDone) {
    formModal({
      title: 'Promote or graduate a class', submitLabel: 'Move students',
      fields: [
        { name: 'from_class_id', label: 'From class', type: 'select', required: true, placeholder: 'Choose…', options: classes.map((c) => ({ value: c.id, label: `${c.name} (${c.student_count})` })), full: true },
        { name: 'action', label: 'Action', type: 'select', required: true, full: true, default: 'promote', options: [{ value: 'promote', label: 'Promote to another class' }, { value: 'graduate', label: 'Graduate (they leave the school)' }] },
        { name: 'to_class_id', label: 'To class (for promotion)', type: 'select', placeholder: 'Choose…', options: classes.map((c) => ({ value: c.id, label: c.name })), full: true },
        { heading: 'Every active student in the class moves. To keep some back (repeaters), edit those students afterwards.' },
      ],
      onSubmit: async (d) => {
        const r = await api('POST', '/api/promotions', { from_class_id: d.from_class_id, action: d.action, to_class_id: d.action === 'promote' ? d.to_class_id : undefined });
        toast(`${r.moved} student(s) moved`);
        onDone();
      },
    });
  }

  /* ---------------- list ---------------- */
  async function list(el, ctx, openNew) {
    const classes = await api('GET', '/api/classes');
    const state = SF.store.persist('students', { q: '', class_id: '', status: '', page: 1 });
    for (const k of ['class_id', 'status']) if (ctx.query.has(k)) { state[k] = ctx.query.get(k) || ''; state.page = 1; }
    const canWrite = SF.can('students:write');
    mount(el, html`
      <div class="toolbar">
        <input type="search" class="grow" id="q" placeholder="Search by name or admission number" aria-label="Search students" value="${state.q}">
        <select id="fClass" aria-label="Class"><option value="">All classes</option>${classes.map((c) => html`<option value="${c.id}">${c.name}</option>`)}<option value="none">No class</option></select>
        <select id="fStatus" aria-label="Status"><option value="">All statuses</option>${STATUSES.map((s) => html`<option value="${s}">${cap(s)}</option>`)}</select>
        ${state.q || state.class_id || state.status ? html`<button class="btn btn-ghost btn-sm" id="reset">✕ Clear filters</button>` : ''}
        ${canWrite ? html`<button class="btn btn-primary" id="add">+ Add student</button><button class="btn btn-secondary" id="promote">Promote class</button>` : ''}
        ${SF.can('export:read') ? html`<a class="btn btn-secondary" href="/api/export/students.csv">Export CSV</a>` : ''}
      </div>
      <section class="panel"><div id="tbl"></div></section>`);
    el.querySelector('#fClass').value = state.class_id;
    el.querySelector('#fStatus').value = state.status;
    const tbl = el.querySelector('#tbl');
    const showBalance = SF.can('fees:read');

    async function load() {
      try {
        const data = await api('GET', '/api/students' + qs({ q: state.q, class_id: state.class_id, status: state.status, page: state.page, limit: 20 }));
        const cols = [
          { label: 'Adm. no.', render: (s) => s.admission_no }, { label: 'Name', render: (s) => html`<b>${s.first_name} ${s.last_name}</b>` },
          { label: 'Class', render: (s) => s.class_name || '—' },
          { label: 'Parent / guardian', render: (s) => (s.guardian_name ? html`${s.guardian_name}<br><span class="muted small">${s.guardian_phone || ''}</span>` : '—') },
          { label: 'Status', render: (s) => statusBadge(s.status) },
          ...(showBalance ? [{ label: 'Fee balance', cls: 'num', render: (s) => (s.balance > 0 ? html`<span class="neg">${money(s.balance)}</span>` : s.balance < 0 ? money(s.balance) : html`<span class="muted">—</span>`) }] : []),
        ];
        mount(tbl, html`${table(cols, data.items, { empty: 'No students match. Try a different search or add your first student.', rowAttr: (s) => `class="clickable" data-id="${Number(s.id)}"` })}${pager(data)}`);
        tbl.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/students/${tr.dataset.id}`; }));
        bindPager(tbl, (p) => { state.page = p; load(); });
      } catch (e) { fail(e); }
    }
    el.querySelector('#q').addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); state.page = 1; load(); }));
    const reset = el.querySelector('#reset');
    if (reset) reset.addEventListener('click', () => { state.q = ''; state.class_id = ''; state.status = ''; state.page = 1; SF.reload(); });
    el.querySelector('#fClass').addEventListener('change', (e) => { state.class_id = e.target.value; state.page = 1; load(); });
    el.querySelector('#fStatus').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; load(); });
    if (canWrite) {
      el.querySelector('#add').addEventListener('click', () => studentForm({ classes, onDone: load }));
      el.querySelector('#promote').addEventListener('click', async () => promoteModal(await api('GET', '/api/classes'), load));
      if (openNew) studentForm({ classes, onDone: load });
    }
    await load();
  }

  /* ---------------- profile ---------------- */
  async function profile(el, id, ctx) {
    const s = await api('GET', `/api/students/${id}`);
    ctx.setHeader(`${s.first_name} ${s.last_name}`, `${SF.me.school.name} · ${s.admission_no}`);
    const canWrite = SF.can('students:write');
    const classes = canWrite ? await api('GET', '/api/classes') : [];
    const att = s.attendance;

    mount(el, html`
      <a class="back" href="#/students">← All students</a>
      <section class="panel">
        <div class="page-actions" style="margin:0 0 14px">
          <span class="avatar" style="width:52px;height:52px">${SF.ui.initials(`${s.first_name} ${s.last_name}`)}</span>
          <div><b style="font-size:18px">${s.first_name} ${s.last_name}</b><br><span class="muted small">${s.admission_no}</span></div>
          <span class="spacer"></span>
          ${SF.can('results:read') && s.class_id ? html`<button class="btn btn-secondary" id="report">Report card</button>` : ''}
          ${canWrite && s.status === 'applicant' ? html`<button class="btn btn-primary" id="admit">Admit student</button>` : ''}
          ${canWrite ? html`<button class="btn btn-secondary" id="edit">Edit</button>` : ''}
        </div>
        <div class="kv">
          <div><small>Class</small><b>${s.class_name || '—'}</b></div>
          <div><small>Status</small><b>${statusBadge(s.status)}</b></div>
          <div><small>Gender</small><b>${s.gender ? cap(s.gender) : '—'}</b></div>
          <div><small>Date of birth</small><b>${s.dob ? `${fmtDate(s.dob)} (${age(s.dob)} yrs)` : '—'}</b></div>
          <div><small>Admitted</small><b>${fmtDate(s.admitted_on)}</b></div>
          <div><small>Address</small><b>${s.address || '—'}</b></div>
          <div><small>Previous school</small><b>${s.previous_school || '—'}</b></div>
        </div>
      </section>
      <div class="grid-2">
        <section class="panel"><h3>Parents & guardians</h3>
          ${s.guardians.length ? s.guardians.map((g) => html`<div class="list-row"><span><b>${g.name}</b> ${g.is_primary ? badge('Primary', 'green') : ''}<br><span class="muted small">${g.relationship || ''}</span></span>
            <span class="right">${g.phone ? html`<a href="tel:${g.phone}">${g.phone}</a>` : ''}${g.email ? html`<br><a href="mailto:${g.email}" class="small">${g.email}</a>` : ''}</span></div>`) : html`<div class="empty">No guardian on file</div>`}
        </section>
        <section class="panel"><h3>Attendance</h3>
          ${att.total ? html`<div class="overview-row" style="grid-template-columns:repeat(4,1fr)"><div><small>Rate</small><strong>${pct(att.rate)}</strong></div><div><small>Present</small><strong>${att.present}</strong></div><div><small>Late</small><strong>${att.late}</strong></div><div><small>Absent</small><strong>${att.absent}</strong></div></div>${bar(att.rate)}` : html`<div class="empty">No attendance recorded yet</div>`}
        </section>
      </div>
      ${s.portal_users ? html`<section class="panel"><div class="panel-head"><h3>Parent portal access</h3>${canWrite ? html`<button class="btn btn-secondary btn-sm" id="grant">+ Give access</button>` : ''}</div>
        ${s.portal_users.length ? s.portal_users.map((u) => html`<div class="list-row"><span><b>${u.name}</b><br><span class="muted small">${u.email}</span></span><button class="btn btn-danger btn-sm" data-revoke="${u.id}">Remove</button></div>`)
          : html`<p class="muted small">Parents can sign in to see attendance, fees and published report cards. Brothers and sisters share one login.</p>`}</section>` : ''}
      ${s.invoices ? html`<section class="panel"><div class="panel-head"><h3>Fees</h3><span>Balance: <b class="${s.fees.balance > 0 ? 'neg' : 'pos'}">${money(s.fees.balance)}</b></span></div>
        ${table([
          { label: 'Description', render: (i) => html`${i.description}<br><span class="muted small">Term ${i.term || '—'} · ${i.academic_year || ''}</span>` },
          { label: 'Amount', cls: 'num', render: (i) => money(i.amount) }, { label: 'Paid', cls: 'num', render: (i) => money(i.paid) },
          { label: 'Balance', cls: 'num', render: (i) => (i.balance > 0 ? html`<span class="neg">${money(i.balance)}</span>` : badge('Paid', 'green')) },
          { label: '', cls: 'num', render: (i) => (i.balance > 0 && SF.can('fees:write') ? html`<button class="btn btn-secondary btn-sm" data-pay="${i.id}">Record payment</button>` : '') },
        ], s.invoices, { empty: 'No invoices yet.' })}</section>` : ''}`);

    const reload = () => SF.reload();
    if (el.querySelector('#edit')) el.querySelector('#edit').addEventListener('click', () => studentForm({ student: s, classes, onDone: reload }));
    if (el.querySelector('#report')) el.querySelector('#report').addEventListener('click', () => SF.showReportCard(s.id));
    if (el.querySelector('#admit')) el.querySelector('#admit').addEventListener('click', () => formModal({
      title: `Admit ${s.first_name}`, submitLabel: 'Admit', fields: [{ name: 'class_id', label: 'Class', type: 'select', required: true, placeholder: 'Choose…', options: classes.map((c) => ({ value: c.id, label: c.name })), full: true, default: s.class_id }],
      onSubmit: async (d) => { const r = await api('POST', `/api/students/${s.id}/admit`, { class_id: d.class_id }); toast(`Admitted. Admission number ${r.admission_no}`); reload(); },
    }));
    if (el.querySelector('#grant')) el.querySelector('#grant').addEventListener('click', () => {
      const g = s.guardians[0] || {};
      formModal({
        title: 'Give parent portal access', submitLabel: 'Create access', values: { name: g.name, email: g.email, phone: g.phone },
        fields: [
          { name: 'name', label: 'Parent name', required: true, full: true }, { name: 'email', label: 'Email (used to sign in)', type: 'email', required: true, full: true, help: 'If this parent already has a login, this child is added to it.' },
          { name: 'phone', label: 'Phone', type: 'tel', full: true },
        ],
        onSubmit: async (d) => {
          const r = await api('POST', `/api/students/${s.id}/portal`, d);
          if (r.temporary_password) secretModal('Portal login created', `Give ${d.email} this temporary password:`, r.temporary_password);
          else toast('Added to the parent’s existing login');
          reload();
        },
      });
    });
    el.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmBox({ message: 'Remove this parent’s access to this student?', confirmLabel: 'Remove', danger: true }))) return;
      try { await api('DELETE', `/api/students/${s.id}/portal/${b.dataset.revoke}`); toast('Access removed'); reload(); } catch (e) { fail(e); }
    }));
    el.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => {
      const inv = s.invoices.find((i) => i.id === Number(b.dataset.pay));
      SF.recordPayment({ id: inv.id, description: inv.description, balance: inv.balance, student: `${s.first_name} ${s.last_name}` }, reload);
    }));
  }

  SF.views.students = {
    title: 'Students',
    async render(el, args, ctx) {
      if (args[0] && args[0] !== 'new') { await profile(el, args[0], ctx); return; }
      await list(el, ctx, args[0] === 'new');
    },
  };
})();
