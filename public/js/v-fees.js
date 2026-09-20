(function () {
  const SF = window.SF;
  const { api, qs } = SF;
  const { html, raw, mount, money, parseMoney, fmtDate, fmtDateTime, table, pager, bindPager, badge, bar, pct, toast, fail, formModal, modal, printModal, debounce, cap } = SF.ui;

  const METHODS = [{ value: 'cash', label: 'Cash' }, { value: 'momo', label: 'Mobile money' }, { value: 'bank', label: 'Bank transfer' }, { value: 'cheque', label: 'Cheque' }];
  const methodLabel = (m) => (METHODS.find((x) => x.value === m) || { label: cap(m) }).label;

  function receiptModal(r) {
    const m = modal({ title: 'Payment receipt', content: html`
      <div class="report-card" style="border:0;padding:6px 0">
        <div class="rc-head"><div><h2>${SF.me.school.name}</h2><p><b>Official receipt</b></p></div></div>
        <div class="kv" style="margin-bottom:14px">
          <div><small>Receipt no.</small><b>${r.receipt_no}</b></div><div><small>Date</small><b>${fmtDateTime(r.received_at)}</b></div>
          <div><small>Student</small><b>${r.student}</b></div><div><small>Adm. no.</small><b>${r.admission_no || '—'}</b></div>
          <div><small>For</small><b>${r.description}</b></div><div><small>Method</small><b>${methodLabel(r.method)}${r.reference ? ` · ${r.reference}` : ''}</b></div>
          <div><small>Amount paid</small><b style="font-size:20px">${money(r.amount)}</b></div>
          ${r.balance_after !== undefined ? html`<div><small>Balance on this invoice</small><b>${money(r.balance_after)}</b></div>` : ''}
        </div><p class="muted small">Thank you. Keep this receipt as proof of payment.</p></div>
      <div class="form-actions no-print"><button class="btn btn-secondary" data-close>Close</button><button class="btn btn-primary" data-print>Print</button></div>` });
    m.body.querySelector('[data-close]').addEventListener('click', m.close);
    m.body.querySelector('[data-print]').addEventListener('click', printModal);
  }

  // inv: { id, description, balance (pesewas), student }
  SF.recordPayment = function (inv, onDone) {
    formModal({
      title: `Record payment — ${inv.student}`, submitLabel: 'Record payment',
      values: { amount: (inv.balance / 100).toFixed(2), method: 'cash' },
      fields: [
        { heading: `${inv.description} · outstanding ${money(inv.balance)}` },
        { name: 'amount', label: 'Amount (GH₵)', type: 'number', step: '0.01', min: '0.01', required: true, full: true },
        { name: 'method', label: 'Method', type: 'select', options: METHODS, required: true },
        { name: 'reference', label: 'Reference', placeholder: 'MoMo transaction ID, cheque no…' },
      ],
      onSubmit: async (d) => {
        const p = parseMoney(d.amount);
        if (!p) throw new Error('Enter a valid amount, for example 250.50');
        const r = await api('POST', '/api/payments', { invoice_id: inv.id, amount: p, method: d.method, reference: d.reference });
        toast(`Recorded ${r.receipt_no}`);
        receiptModal({ ...r, student: r.student.name, admission_no: r.student.admission_no });
        onDone();
      },
    });
  };

  function billModal(classes, onDone) {
    const s = SF.me.school;
    formModal({
      title: 'Generate invoices', submitLabel: 'Create invoices', values: { term: s.current_term },
      fields: [
        { name: 'description', label: 'What is this bill for?', required: true, full: true, placeholder: 'School fees, PTA levy, Exams fee…' },
        { name: 'amount', label: 'Amount per student (GH₵)', type: 'number', step: '0.01', min: '0.01', required: true },
        { name: 'term', label: 'Term', type: 'select', options: [1, 2, 3, 4].map((t) => ({ value: t, label: `Term ${t}` })) },
        { name: 'class_id', label: 'Bill', type: 'select', placeholder: 'Every active student', options: classes.map((c) => ({ value: c.id, label: `Only ${c.name}` })), full: true },
        { name: 'due_date', label: 'Due date', type: 'date', full: true, help: 'Running the same bill twice never charges a student twice.' },
      ],
      onSubmit: async (d) => {
        const p = parseMoney(d.amount);
        if (!p) throw new Error('Enter a valid amount, for example 850.00');
        const r = await api('POST', '/api/invoices', { description: d.description, amount: p, term: d.term, class_id: d.class_id, due_date: d.due_date });
        toast(`${r.created} invoice(s) created${r.skipped ? `, ${r.skipped} already billed` : ''}`);
        onDone();
      },
    });
  }

  function remindModal(classes) {
    formModal({
      title: 'Send fee reminders', submitLabel: 'Queue reminders',
      fields: [
        { heading: 'Reminders go by SMS and email to the primary parent or guardian of every student who owes fees.' },
        { name: 'class_id', label: 'Who', type: 'select', placeholder: 'Every class', options: classes.map((c) => ({ value: c.id, label: c.name })), full: true },
        { name: 'overdue_only', label: 'Only fees past their due date', type: 'checkbox', default: '1', full: true },
      ],
      onSubmit: async (d) => {
        const r = await api('POST', '/api/fees/remind', { class_id: d.class_id, overdue_only: !!d.overdue_only });
        toast(`${r.queued} reminder(s) queued${r.no_contact ? ` · ${r.no_contact} have no phone or email` : ''}`);
      },
    });
  }

  SF.views.fees = {
    title: 'Fees & Finance',
    async render(el, args, ctx) {
      const [sum, classes] = await Promise.all([api('GET', '/api/fees/summary'), api('GET', '/api/classes')]);
      const w = SF.can('fees:write');
      const state = SF.store.persist('fees', { tab: 'invoices', q: '', status: '', class_id: '', page: 1 });
      if (ctx.query.get('tab') === 'payments' || ctx.query.get('tab') === 'invoices') { state.tab = ctx.query.get('tab'); state.page = 1; }
      mount(el, html`
        <div class="stat-grid">
          <div class="stat"><small>Billed · ${sum.academic_year || 'this year'}</small><b>${money(sum.billed)}</b><span>Total invoiced</span></div>
          <div class="stat"><small>Collected</small><b>${money(sum.collected)}</b><span>${pct(sum.rate)} of billed</span></div>
          <div class="stat"><small>Outstanding</small><b class="${sum.outstanding > 0 ? 'neg' : ''}">${money(sum.outstanding)}</b><span>${sum.students_owing} students owe fees</span></div>
          <div class="stat"><small>Collection rate</small><b>${pct(sum.rate)}</b>${bar(sum.rate || 0)}</div>
        </div>
        <div class="page-actions" style="margin-top:16px">
          <div class="tabs" style="margin:0"><button data-tab="invoices" class="${state.tab === 'invoices' ? 'active' : ''}">Invoices</button><button data-tab="payments" class="${state.tab === 'payments' ? 'active' : ''}">Payments</button></div><span class="spacer"></span>
          ${w ? html`<button class="btn btn-secondary" id="remind">Send reminders</button><button class="btn btn-primary" id="bill">+ Generate invoices</button>` : ''}
          ${SF.can('export:read') ? html`<a class="btn btn-secondary" href="/api/export/invoices.csv">Export CSV</a>` : ''}
        </div>
        <div id="filters" class="toolbar ${state.tab === 'invoices' ? '' : 'hidden'}">
          <input type="search" id="q" class="grow" placeholder="Search student or admission no." aria-label="Search" value="${state.q}">
          <select id="fStatus" aria-label="Status"><option value="">All invoices</option><option value="outstanding">Outstanding</option><option value="overdue">Overdue</option><option value="paid">Paid</option></select>
          <select id="fClass" aria-label="Class"><option value="">All classes</option>${classes.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>
        </div>
        <section class="panel"><div id="tbl"></div></section>`);
      el.querySelector('#fStatus').value = state.status;
      el.querySelector('#fClass').value = state.class_id;
      const tbl = el.querySelector('#tbl');
      const reload = () => SF.reload();

      async function load() {
        try {
          if (state.tab === 'invoices') {
            const d = await api('GET', '/api/invoices' + qs({ q: state.q, status: state.status, class_id: state.class_id, page: state.page, limit: 20 }));
            const overdue = (i) => i.balance > 0 && i.due_date && i.due_date < SF.ui.todayStr();
            mount(tbl, html`${table([
              { label: 'Student', render: (i) => html`<a href="#/students/${i.student_id}"><b>${i.first_name} ${i.last_name}</b></a><br><span class="muted small">${i.admission_no} · ${i.class_name || 'No class'}</span>` },
              { label: 'Invoice', render: (i) => html`${i.description}<br><span class="muted small">Term ${i.term || '—'} · ${i.academic_year || ''}</span>` },
              { label: 'Amount', cls: 'num', render: (i) => money(i.amount) }, { label: 'Paid', cls: 'num', render: (i) => money(i.paid) },
              { label: 'Balance', cls: 'num', render: (i) => (i.balance > 0 ? html`<span class="neg">${money(i.balance)}</span>` : '—') },
              { label: 'Due', render: (i) => html`${fmtDate(i.due_date)}${overdue(i) ? html` ${badge('Overdue', 'red')}` : ''}` },
              { label: '', cls: 'num', render: (i) => (i.balance > 0 ? (w ? html`<button class="btn btn-secondary btn-sm" data-pay="${i.id}">Record payment</button>` : '') : badge('Paid', 'green')) },
            ], d.items, { empty: 'No invoices match. Use “Generate invoices” to bill a class.' })}${pager(d)}`);
            tbl.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => {
              const i = d.items.find((x) => x.id === Number(b.dataset.pay));
              SF.recordPayment({ id: i.id, description: i.description, balance: i.balance, student: `${i.first_name} ${i.last_name}` }, reload);
            }));
            bindPager(tbl, (p) => { state.page = p; load(); });
          } else {
            const d = await api('GET', '/api/payments' + qs({ page: state.page, limit: 20 }));
            mount(tbl, html`${table([
              { label: 'Receipt', render: (p) => html`<b>${p.receipt_no}</b>` }, { label: 'Date', render: (p) => fmtDateTime(p.received_at) },
              { label: 'Student', render: (p) => `${p.first_name} ${p.last_name}` }, { label: 'For', render: (p) => p.description },
              { label: 'Method', render: (p) => methodLabel(p.method) }, { label: 'Received by', render: (p) => p.received_by || '—' },
              { label: 'Amount', cls: 'num', render: (p) => html`<b class="pos">${money(p.amount)}</b>` },
              { label: '', cls: 'num', render: (p) => html`<button class="btn btn-secondary btn-sm" data-rct="${p.id}">Receipt</button>` },
            ], d.items, { empty: 'No payments recorded yet.' })}${pager(d)}`);
            tbl.querySelectorAll('[data-rct]').forEach((b) => b.addEventListener('click', () => {
              const p = d.items.find((x) => x.id === Number(b.dataset.rct));
              receiptModal({ receipt_no: p.receipt_no, received_at: p.received_at, student: `${p.first_name} ${p.last_name}`, admission_no: p.admission_no, description: p.description, method: p.method, reference: p.reference, amount: p.amount });
            }));
            bindPager(tbl, (p) => { state.page = p; load(); });
          }
        } catch (e) { fail(e); }
      }

      el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
        state.tab = b.dataset.tab; state.page = 1;
        el.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
        el.querySelector('#filters').classList.toggle('hidden', state.tab !== 'invoices');
        load();
      }));
      el.querySelector('#q').addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); state.page = 1; load(); }));
      el.querySelector('#fStatus').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; load(); });
      el.querySelector('#fClass').addEventListener('change', (e) => { state.class_id = e.target.value; state.page = 1; load(); });
      if (w) {
        el.querySelector('#bill').addEventListener('click', () => billModal(classes, reload));
        el.querySelector('#remind').addEventListener('click', () => remindModal(classes));
      }
      await load();
    },
  };
})();
