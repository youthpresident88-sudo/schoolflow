(function () {
  const SF = window.SF;
  const { api, qs } = SF;
  const { html, raw, mount, table, pager, bindPager, badge, toast, fail, formModal, confirmBox, secretModal, fmtDate, fmtDateTime, ago, cap, debounce } = SF.ui;

  const ROLE_OPTS = [{ value: 'teacher', label: 'Teacher' }, { value: 'principal', label: 'Principal / Headteacher' }, { value: 'accountant', label: 'Accountant / Bursar' }];
  const ROLE_KIND = { admin: 'red', principal: 'amber', teacher: 'green', accountant: 'blue' };

  /* ---------- staff ---------- */
  async function staffTab(box) {
    const staff = await api('GET', '/api/staff');
    const w = SF.can('staff:write');
    mount(box, html`<div class="page-actions">${w ? html`<button class="btn btn-primary" id="add">+ Add staff</button>` : ''}<span class="spacer"></span><span class="muted small">${staff.filter((s) => s.active).length} active</span></div>
      ${table([
        { label: 'Name', render: (s) => html`<b>${s.name}</b><br><span class="muted small">${s.email}${s.phone ? ` · ${s.phone}` : ''}</span>` },
        { label: 'Role', render: (s) => badge(cap(s.role), ROLE_KIND[s.role]) },
        { label: 'Classes', cls: 'num', render: (s) => s.classes }, { label: 'Open tasks', cls: 'num', render: (s) => s.open_tasks },
        { label: 'Status', render: (s) => (s.active ? badge('Active', 'green') : badge('Deactivated', 'red')) },
        { label: '', cls: 'num', render: (s) => (w && s.role !== 'admin' ? html`<div class="row-actions"><button class="btn btn-secondary btn-sm" data-edit="${s.id}">Edit</button><button class="btn btn-secondary btn-sm" data-reset="${s.id}">Reset password</button></div>` : '') },
      ], staff)}`);
    if (!w) return;
    const reload = () => SF.reload();
    box.querySelector('#add').addEventListener('click', () => formModal({
      title: 'Add staff member', submitLabel: 'Create account',
      fields: [
        { name: 'name', label: 'Full name', required: true, full: true }, { name: 'email', label: 'Email (used to sign in)', type: 'email', required: true, full: true },
        { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'role', label: 'Role', type: 'select', required: true, options: ROLE_OPTS, default: 'teacher' },
      ],
      onSubmit: async (d) => {
        const r = await api('POST', '/api/staff', d);
        secretModal('Account created', `Give ${r.staff.name} this temporary password to sign in with ${r.staff.email}:`, r.temporary_password);
        reload();
      },
    }));
    box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const s = staff.find((x) => x.id === Number(b.dataset.edit));
      formModal({
        title: `Edit ${s.name}`, values: { ...s, active: s.active ? '1' : '' }, submitLabel: 'Save',
        fields: [
          { name: 'name', label: 'Full name', required: true, full: true }, { name: 'phone', label: 'Phone', type: 'tel' },
          { name: 'role', label: 'Role', type: 'select', options: ROLE_OPTS, required: true }, { name: 'active', label: 'Account active', type: 'checkbox', full: true, help: 'Untick to stop this person signing in.' },
        ],
        onSubmit: async (d) => { await api('PUT', `/api/staff/${s.id}`, { name: d.name, phone: d.phone, role: d.role, active: !!d.active }); toast('Saved'); reload(); },
      });
    }));
    box.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
      const s = staff.find((x) => x.id === Number(b.dataset.reset));
      if (!(await confirmBox({ message: `Reset ${s.name}'s password? They will be signed out everywhere.`, confirmLabel: 'Reset password', danger: true }))) return;
      try { const r = await api('POST', `/api/staff/${s.id}/reset-password`, {}); secretModal('Password reset', `New temporary password for ${s.name}:`, r.temporary_password); } catch (e) { fail(e); }
    }));
  }

  /* ---------- tasks ---------- */
  async function tasksTab(box) {
    const tasks = await api('GET', '/api/tasks');
    const w = SF.can('tasks:write');
    const staff = w ? (await api('GET', '/api/staff')).filter((s) => s.active) : [];
    mount(box, html`<div class="page-actions">${w ? html`<button class="btn btn-primary" id="add">+ Assign task</button>` : ''}<span class="spacer"></span><span class="muted small">${tasks.filter((t) => t.status === 'open').length} open</span></div>
      ${table([
        { label: 'Task', render: (t) => html`<b style="${t.status === 'done' ? 'text-decoration:line-through;opacity:.6' : ''}">${t.title}</b>${t.description ? html`<br><span class="muted small">${t.description}</span>` : ''}` },
        ...(w ? [{ label: 'Assigned to', render: (t) => t.assignee }] : []),
        { label: 'Due', render: (t) => html`${fmtDate(t.due_date)}${t.overdue ? html` ${badge('Overdue', 'red')}` : ''}` },
        { label: 'Status', render: (t) => (t.status === 'done' ? badge('Done', 'green') : badge('Open', 'amber')) },
        { label: '', cls: 'num', render: (t) => html`<div class="row-actions"><button class="btn btn-secondary btn-sm" data-toggle="${t.id}" data-to="${t.status === 'done' ? 'open' : 'done'}">${t.status === 'done' ? 'Reopen' : 'Mark done'}</button>${w ? html`<button class="btn btn-danger btn-sm" data-del="${t.id}">Delete</button>` : ''}</div>` },
      ], tasks, { empty: w ? 'No tasks yet. Assign work to teachers and track it here.' : 'You have no tasks. 🎉' })}`);
    const reload = () => SF.reload();
    if (w) box.querySelector('#add').addEventListener('click', () => formModal({
      title: 'Assign a task', submitLabel: 'Assign',
      fields: [
        { name: 'title', label: 'Task', required: true, full: true, placeholder: 'Submit term 2 lesson plans' },
        { name: 'assigned_to', label: 'Assign to', type: 'select', required: true, placeholder: 'Choose…', options: staff.map((s) => ({ value: s.id, label: `${s.name} (${cap(s.role)})` })) },
        { name: 'due_date', label: 'Due date', type: 'date' }, { name: 'description', label: 'Details', type: 'textarea', full: true },
      ],
      onSubmit: async (d) => { await api('POST', '/api/tasks', d); toast('Task assigned'); reload(); },
    }));
    box.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('PUT', `/api/tasks/${b.dataset.toggle}/status`, { status: b.dataset.to }); reload(); } catch (e) { fail(e); }
    }));
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmBox({ message: 'Delete this task?', confirmLabel: 'Delete', danger: true }))) return;
      try { await api('DELETE', `/api/tasks/${b.dataset.del}`); reload(); } catch (e) { fail(e); }
    }));
  }

  /* ---------- activity log ---------- */
  async function activityTab(box) {
    const state = { q: '', page: 1 };
    mount(box, html`<div class="toolbar"><input type="search" id="q" class="grow" placeholder="Search activity" aria-label="Search activity"></div><div id="log"></div>`);
    const log = box.querySelector('#log');
    async function load() {
      try {
        const d = await api('GET', '/api/audit' + qs({ q: state.q, page: state.page, limit: 25 }));
        mount(log, html`${table([
          { label: 'When', render: (a) => html`<span class="nowrap">${fmtDateTime(a.created_at)}</span>` }, { label: 'Who', render: (a) => (a.user_name ? html`${a.user_name}<br><span class="muted small">${cap(a.user_role)}</span>` : html`<span class="muted">Public visitor</span>`) },
          { label: 'What', render: (a) => a.summary || a.action },
        ], d.items, { empty: 'Nothing recorded yet.' })}${pager(d)}`);
        bindPager(log, (p) => { state.page = p; load(); });
      } catch (e) { fail(e); }
    }
    box.querySelector('#q').addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); state.page = 1; load(); }));
    await load();
  }

  /* ---------- SMS / email outbox ---------- */
  async function outboxTab(box) {
    const d = await api('GET', '/api/notifications');
    const devMode = d.items.some((n) => n.error && n.error.startsWith('dev-log'));
    mount(box, html`
      ${devMode ? html`<div class="notice">No SMS or email gateway is connected yet, so messages are logged here but not delivered. Set <b>SF_SMS_URL</b> and <b>SF_EMAIL_URL</b> on the server to send for real.</div>` : ''}
      <div class="page-actions"><span class="muted small">Queued ${d.counts.queued || 0} · Sent ${d.counts.sent || 0} · Failed ${d.counts.failed || 0}</span><span class="spacer"></span>
        ${SF.can('settings:write') ? html`<button class="btn btn-secondary btn-sm" id="run">Send queued now</button>` : ''}</div>
      ${table([
        { label: 'Time', render: (n) => html`<span class="nowrap">${ago(n.created_at)}</span>` }, { label: 'Channel', render: (n) => badge(n.channel.toUpperCase(), n.channel === 'sms' ? 'green' : 'blue') },
        { label: 'To', render: (n) => n.recipient }, { label: 'Message', render: (n) => html`<span class="small">${n.subject ? html`<b>${n.subject}</b> — ` : ''}${n.body.length > 90 ? `${n.body.slice(0, 90)}…` : n.body}</span>` },
        { label: 'Status', render: (n) => badge(cap(n.status), n.status === 'sent' ? 'green' : n.status === 'failed' ? 'red' : 'amber') },
      ], d.items, { empty: 'No messages have been queued.' })}`);
    const run = box.querySelector('#run');
    if (run) run.addEventListener('click', async () => { try { const r = await api('POST', '/api/notifications/process', {}); toast(`Processed ${r.processed} message(s)`); SF.reload(); } catch (e) { fail(e); } });
  }

  SF.views.staff = {
    title: 'Staff & HR',
    async render(el, args, ctx) {
      const tabs = [['staff', 'Staff', 'staff:read', staffTab], ['tasks', 'Tasks', 'tasks:read', tasksTab], ['activity', 'Activity log', 'audit:read', activityTab], ['outbox', 'SMS & email log', 'audit:read', outboxTab]].filter((t) => SF.can(t[2]));
      if (!SF.can('staff:read')) ctx.setHeader('My tasks');
      const want = ctx.query.get('tab') || SF.views.staff.last;
      let cur = tabs.find((t) => t[0] === want) || tabs[0];
      mount(el, html`<div class="tabs">${tabs.map((t) => html`<button data-tab="${t[0]}">${t[1]}</button>`)}</div><section class="panel"><div id="box"></div></section>`);
      const box = el.querySelector('#box');
      const show = async () => {
        el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === cur[0]));
        SF.views.staff.last = cur[0];
        try { await cur[3](box); } catch (e) { fail(e); }
      };
      el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { cur = tabs.find((t) => t[0] === b.dataset.tab); show(); }));
      await show();
    },
  };
})();
