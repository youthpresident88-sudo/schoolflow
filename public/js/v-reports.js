(function () {
  const SF = window.SF;
  const { api } = SF;
  const { html, mount, money, pct, fmtDateTime, table, bar } = SF.ui;

  const hbar = (label, p, text) => html`<div class="hbar"><span>${label}</span>${bar(p)}<b class="right">${text}</b></div>`;

  SF.views.reports = {
    title: 'Reports & Analytics',
    async render(el) {
      const d = await api('GET', '/api/reports/overview');
      const maxEnroll = Math.max(1, ...d.enrollment.map((c) => c.total));
      const sections = [];

      sections.push(html`<div class="grid-2">
        <section class="panel"><div class="panel-head"><h2>Enrollment by class</h2><span>${d.enrollment.reduce((a, c) => a + c.total, 0)} active students</span></div>
          ${d.enrollment.length ? d.enrollment.map((c) => hbar(c.name || c.class_name, (c.total / maxEnroll) * 100, `${c.total}`)) : html`<div class="empty">No classes yet.</div>`}
          <p class="muted small" style="margin:10px 0 0">${d.enrollment.reduce((a, c) => a + c.male, 0)} boys · ${d.enrollment.reduce((a, c) => a + c.female, 0)} girls</p></section>
        ${d.attendance_by_class ? html`<section class="panel"><div class="panel-head"><h2>Attendance by class</h2><span>Last 30 days</span></div>
          ${d.attendance_by_class.map((c) => hbar(c.class_name, c.rate || 0, c.rate === null ? '—' : `${c.rate}%`))}</section>` : ''}
      </div>`);

      if (d.fees) {
        const overdue = d.overdue || { invoices: 0, amount: 0 };
        sections.push(html`<section class="panel"><div class="panel-head"><h2>Fees · ${d.fees.academic_year || 'this year'}</h2><span>${pct(d.fees.rate)} collected</span></div>
          <div class="overview-row"><div><small>Billed</small><strong>${money(d.fees.billed)}</strong></div><div><small>Collected</small><strong>${money(d.fees.collected)}</strong></div><div><small>Overdue</small><strong class="${overdue.amount ? 'neg' : ''}">${money(overdue.amount)}</strong><small>${overdue.invoices} invoices</small></div></div>
          <div style="margin-top:14px">${d.fees_by_class.length ? d.fees_by_class.map((c) => hbar(c.class_name, c.billed ? (c.collected / c.billed) * 100 : 0, c.billed ? `${Math.round((c.collected / c.billed) * 100)}%` : '—')) : html`<div class="empty">No invoices yet.</div>`}</div>
          ${d.recent_payments.length ? html`<h3 style="margin-top:18px">Recent payments</h3>${table([
            { label: 'Receipt', render: (p) => p.receipt_no }, { label: 'Student', render: (p) => `${p.first_name} ${p.last_name}` },
            { label: 'When', render: (p) => fmtDateTime(p.received_at) }, { label: 'Amount', cls: 'num', render: (p) => html`<b class="pos">${money(p.amount)}</b>` },
          ], d.recent_payments)}` : ''}</section>`);
      }

      if (d.subject_averages) {
        const gmax = Math.max(1, ...d.grade_distribution.map((g) => g.count));
        sections.push(html`<div class="grid-2">
          <section class="panel"><div class="panel-head"><h2>Average score by subject</h2><span>Term ${d.period.term}</span></div>
            ${d.subject_averages.length ? d.subject_averages.map((s) => hbar(s.subject, s.average, `${s.average}`)) : html`<div class="empty">No scores entered this term.</div>`}</section>
          <section class="panel"><div class="panel-head"><h2>Grade distribution</h2><span>All subjects</span></div>
            ${d.grade_distribution.map((g) => hbar(`Grade ${g.grade}`, (g.count / gmax) * 100, `${g.count}`))}</section></div>`);
      }
      mount(el, html`${sections}`);
    },
  };
})();
