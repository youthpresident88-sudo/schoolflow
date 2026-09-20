(function () {
  const SF = window.SF;
  const { api, qs } = SF;
  const { html, raw, mount, money, pct, fmtDate, fmtDateTime, ago, table, badge, bar, modal, printModal, ordinal, toast, fail, cap } = SF.ui;

  const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const ATT_KIND = { present: 'green', late: 'amber', absent: 'red', excused: 'blue' };

  function reportModal(child, year, term) {
    const m = modal({ title: `${child.first_name}'s report card`, wide: true });
    (async () => {
      try {
        const rep = await api('GET', `/api/portal/children/${child.id}/report` + qs({ year, term }));
        mount(m.body, html`<div class="toolbar no-print"><span style="flex:1"></span><button class="btn btn-primary btn-sm" id="print">Print</button></div>${SF.renderReportCard(rep)}`);
        m.body.querySelector('#print').addEventListener('click', printModal);
      } catch (e) { mount(m.body, html`<div class="empty">${e.message}</div>`); }
    })();
  }

  async function detail(el, id, ctx, solo) {
    const d = await api('GET', `/api/portal/children/${id}`);
    const s = d.student; const a = d.attendance; const f = d.fees;
    ctx.setHeader(`${s.first_name} ${s.last_name}`, `${SF.me.school.name} · ${s.class_name || 'No class'}`);
    const tabs = [['overview', 'Overview'], ['reports', `Report cards${d.reports.length ? ` (${d.reports.length})` : ''}`], ['fees', 'Fees'], ['timetable', 'Timetable']];
    let tab = 'overview';
    mount(el, html`${solo ? '' : html`<a class="back" href="#/children">← My children</a>`}
      <div class="tabs">${tabs.map(([k, l]) => html`<button data-tab="${k}">${l}</button>`)}</div><div id="tab"></div>`);
    const box = el.querySelector('#tab');

    async function show() {
      el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      if (tab === 'overview') {
        mount(box, html`<div class="stat-grid">
            <div class="stat"><small>Attendance this term</small><b>${pct(a.rate)}</b><span>${a.total ? `${a.present + a.late} of ${a.total} days` : 'Nothing recorded yet'}</span></div>
            <div class="stat"><small>Fee balance</small><b class="${f.balance > 0 ? 'neg' : 'pos'}">${money(f.balance)}</b><span>${f.balance > 0 ? 'Outstanding' : 'Fully paid'}</span></div>
            <div class="stat"><small>Report cards</small><b>${d.reports.length}</b><span>Released by the school</span></div>
            <div class="stat"><small>Class</small><b style="font-size:20px">${s.class_name || '—'}</b><span>${s.admission_no}</span></div></div>
          <section class="panel" style="margin-top:15px"><div class="panel-head"><h2>Recent attendance</h2><a href="#/messages" class="small">Message a teacher</a></div>
            ${d.recent_attendance.length ? html`<div style="display:flex;gap:8px;flex-wrap:wrap">${d.recent_attendance.map((r) => html`<span title="${fmtDate(r.date)}">${badge(`${fmtDate(r.date).slice(0, 6)} · ${cap(r.status)}`, ATT_KIND[r.status])}</span>`)}</div>` : html`<div class="empty">No attendance recorded yet.</div>`}</section>`);
      } else if (tab === 'reports') {
        mount(box, html`<section class="panel">${d.reports.length ? d.reports.map((r) => html`<div class="list-row"><span><b>Term ${r.term}</b> · ${r.academic_year}</span><button class="btn btn-primary btn-sm" data-rc="${r.term}" data-yr="${r.academic_year}">View report card</button></div>`)
          : html`<div class="empty">No report cards have been released yet. You will see them here as soon as the school publishes them.</div>`}</section>`);
        box.querySelectorAll('[data-rc]').forEach((b) => b.addEventListener('click', () => reportModal(s, b.dataset.yr, b.dataset.rc)));
      } else if (tab === 'fees') {
        mount(box, html`<section class="panel"><div class="panel-head"><h2>Invoices</h2><span>Balance <b class="${f.balance > 0 ? 'neg' : 'pos'}">${money(f.balance)}</b></span></div>
          ${f.balance > 0 ? html`<div class="notice info">To pay, use the school's mobile money number or visit the school office and quote <b>${s.admission_no}</b>.</div>` : ''}
          ${table([
            { label: 'Invoice', render: (i) => html`${i.description}<br><span class="muted small">Term ${i.term || '—'} · ${i.academic_year || ''}</span>` },
            { label: 'Amount', cls: 'num', render: (i) => money(i.amount) }, { label: 'Paid', cls: 'num', render: (i) => money(i.paid) },
            { label: 'Balance', cls: 'num', render: (i) => (i.balance > 0 ? html`<span class="neg">${money(i.balance)}</span>` : badge('Paid', 'green')) },
            { label: 'Due', render: (i) => fmtDate(i.due_date) },
          ], f.invoices, { empty: 'No invoices.' })}</section>
          <section class="panel"><div class="panel-head"><h2>Payments received</h2></div>${table([
            { label: 'Receipt', render: (p) => html`<b>${p.receipt_no}</b>` }, { label: 'Date', render: (p) => fmtDateTime(p.received_at) },
            { label: 'Method', render: (p) => cap(p.method) }, { label: 'Amount', cls: 'num', render: (p) => money(p.amount) },
          ], f.payments, { empty: 'No payments yet.' })}</section>`);
      } else {
        const rows = await api('GET', `/api/portal/children/${id}/timetable`);
        mount(box, html`<section class="panel">${rows.length ? html`<div class="tt">${[1, 2, 3, 4, 5].map((day) => html`<div class="tt-day"><h4>${DAYS[day]}</h4>${rows.filter((r) => r.day === day).map((r) => html`<div class="tt-slot"><b>${r.subject || 'Lesson'}</b>${r.start_time}–${r.end_time}${r.teacher_name ? html`<br>${r.teacher_name}` : ''}</div>`)}</div>`)}</div>` : html`<div class="empty">The timetable has not been set up yet.</div>`}</section>`);
      }
    }
    el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; show().catch(fail); }));
    await show();
  }

  SF.views.children = {
    title: 'My Children',
    async render(el, args, ctx) {
      if (args[0]) return detail(el, args[0], ctx, false);
      const kids = await api('GET', '/api/portal/children');
      if (kids.length === 1) return detail(el, kids[0].id, ctx, true);
      ctx.setHeader('My Children');
      if (!kids.length) { mount(el, html`<section class="panel"><div class="empty">No students are linked to your account yet. Please contact the school office.</div></section>`); return undefined; }
      mount(el, html`<div class="grid-3">${kids.map((k) => html`<a href="#/children/${k.id}" style="text-decoration:none;color:inherit"><section class="panel" style="margin:0">
        <div class="page-actions" style="margin:0 0 10px"><span class="avatar">${SF.ui.initials(`${k.first_name} ${k.last_name}`)}</span><div><b>${k.first_name} ${k.last_name}</b><br><span class="muted small">${k.class_name || 'No class'}</span></div></div>
        <div class="kv" style="grid-template-columns:1fr 1fr"><div><small>Attendance (30 days)</small><b>${pct(k.attendance.rate)}</b></div><div><small>Fee balance</small><b class="${k.fees.balance > 0 ? 'neg' : ''}">${money(k.fees.balance)}</b></div></div></section></a>`)}</div>`);
      return undefined;
    },
  };

  SF.views.feed = {
    title: 'Announcements',
    async render(el) {
      const d = await api('GET', '/api/portal/feed');
      mount(el, html`<div class="dash-grid">
        <section class="panel"><div class="panel-head"><h2>From the school</h2></div>${d.announcements.length ? d.announcements.map((a) => html`<div class="list-row"><div><b>${a.title}</b> ${a.class_name ? badge(a.class_name) : ''}<p>${a.body}</p><span class="muted small">${a.author || 'School'} · ${ago(a.created_at)}</span></div></div>`) : html`<div class="empty">No announcements yet.</div>`}</section>
        <section class="panel"><div class="panel-head"><h2>Upcoming events</h2></div>${d.events.length ? d.events.map((e) => html`<div class="list-row"><span><b>${e.title}</b>${e.location ? html`<br><span class="muted small">${e.location}</span>` : ''}</span><span class="muted nowrap">${fmtDate(e.start_date)}</span></div>`) : html`<div class="empty">No upcoming events.</div>`}</section></div>`);
    },
  };
})();
