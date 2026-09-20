(function () {
  const SF = window.SF;
  const { api, qs } = SF;
  const { html, raw, mount, table, pct, toast, fail, ordinal, fmtDate, formModal, modal, printModal, confirmBox, badge } = SF.ui;

  const gradeOf = (total, scale) => (scale.find((g) => total >= g.min) || scale[scale.length - 1]);
  const draftKey = (o) => `sf:res:${SF.me.user.id}:${o.classId}:${o.subjectId}:${o.year}:${o.term}`;
  const readDraft = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const writeDraft = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
  const clearDraft = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

  /* ---------- printable report card (shared with the parent portal) ---------- */
  function scaleLegend(scale) {
    return scale.map((g, i) => `${g.grade}: ${g.min}${i === 0 ? '–100' : '–' + (scale[i - 1].min - 1)}${g.remark ? ' ' + g.remark : ''}`).join('  ·  ');
  }

  SF.renderReportCard = function (rep) {
    const o = rep.overall; const a = rep.attendance;
    const verifyUrl = rep.verification_code ? `${location.origin}/verify.html?code=${rep.verification_code}` : null;
    return html`<div class="report-card">
      <div class="rc-head">${rep.school.logo ? html`<img src="${rep.school.logo}" alt="">` : ''}<div><h2>${rep.school.name}</h2>${rep.school.motto ? html`<p><i>${rep.school.motto}</i></p>` : ''}<p><b>Terminal report — Term ${rep.term}, ${rep.academic_year}</b></p></div></div>
      <div class="rc-meta">
        <div><small>Student</small><b>${rep.student.name}</b></div><div><small>Admission no.</small><b>${rep.student.admission_no}</b></div>
        <div><small>Class</small><b>${rep.student.class_name || '—'}</b></div>
        <div><small>Position</small><b>${o.position ? `${ordinal(o.position)} of ${o.out_of}` : '—'}</b></div>
        <div><small>Total score</small><b>${o.total === null ? '—' : o.total}</b></div><div><small>Average</small><b>${o.average === null ? '—' : o.average}${o.grade ? ` (${o.grade})` : ''}</b></div>
        <div><small>Attendance${rep.attendance_scoped_to_term ? ' this term' : ''}</small><b>${a.total ? `${a.present + a.late} of ${a.total} days (${a.rate}%)` : '—'}</b></div>
        <div><small>Next term begins</small><b>${fmtDate(rep.next_term_begins)}</b></div>
      </div>
      ${table([
        { label: 'Subject', render: (s) => html`<b>${s.subject}</b>` },
        { label: `Class score (${rep.ca_max})`, cls: 'num', render: (s) => (s.ca_score === null ? '—' : s.ca_score) },
        { label: `Exam (${rep.exam_max})`, cls: 'num', render: (s) => (s.exam_score === null ? '—' : s.exam_score) },
        { label: 'Total (100)', cls: 'num', render: (s) => html`<b>${s.total === null ? 'Incomplete' : s.total}</b>` },
        { label: 'Grade', render: (s) => s.grade || '—' }, { label: 'Remark', render: (s) => s.remark || '' },
        { label: 'Position', cls: 'num', render: (s) => (s.position ? `${ordinal(s.position)} / ${s.out_of}` : '—') },
      ], rep.subjects, { empty: 'No scores have been entered for this term yet.' })}
      <p class="muted small" style="margin:10px 0 0">${scaleLegend(rep.scale)}</p>
      <div class="rc-foot"><div><small class="muted">Class teacher's remark</small><p>${rep.meta.teacher_remark || ''}</p></div><div><small class="muted">Conduct</small><p>${rep.meta.conduct || ''}</p></div>
        <div style="grid-column:1/-1"><small class="muted">Head's remark</small><p>${rep.meta.head_remark || ''}</p></div></div>
      ${verifyUrl ? html`<div class="rc-verify"><span>Verify this report online: <b>${rep.verification_code}</b></span><span>${verifyUrl}</span></div>` : ''}
    </div>`;
  };

  // Staff view of one student's report card (with remark editing)
  SF.showReportCard = function (studentId, opts = {}) {
    const state = { year: opts.year || SF.me.school.academic_year || '', term: opts.term || SF.me.school.current_term || 1 };
    const m = modal({ title: 'Report card', wide: true });
    async function load() {
      try {
        const rep = await api('GET', `/api/students/${studentId}/report` + qs({ year: state.year, term: state.term }));
        mount(m.body, html`
          <div class="toolbar no-print"><label style="margin:0">Term <select id="term">${[1, 2, 3].map((t) => html`<option value="${t}" ${t === state.term ? raw('selected') : ''}>Term ${t}</option>`)}</select></label>
            <span class="muted small">${rep.academic_year}</span>${rep.published ? badge('Published to parents', 'green') : badge('Not published', 'amber')}<span style="flex:1"></span>
            <button class="btn btn-secondary btn-sm" id="remarks">Edit remarks</button><button class="btn btn-primary btn-sm" id="print">Print</button></div>
          ${SF.renderReportCard(rep)}`);
        m.body.querySelector('#term').addEventListener('change', (e) => { state.term = Number(e.target.value); load(); });
        m.body.querySelector('#print').addEventListener('click', printModal);
        m.body.querySelector('#remarks').addEventListener('click', () => formModal({
          title: 'Report card remarks', values: rep.meta, submitLabel: 'Save remarks',
          fields: [
            { name: 'teacher_remark', label: "Class teacher's remark", type: 'textarea', full: true, max: 300 },
            { name: 'conduct', label: 'Conduct', full: true, placeholder: 'Excellent, Good, Satisfactory…' },
            ...(SF.me.user.role === 'admin' || SF.me.user.role === 'principal' ? [{ name: 'head_remark', label: "Head's remark", type: 'textarea', full: true, max: 300 }] : []),
          ],
          onSubmit: async (d) => {
            const body = { academic_year: rep.academic_year, term: rep.term, teacher_remark: d.teacher_remark, conduct: d.conduct };
            if (d.head_remark !== undefined) body.head_remark = d.head_remark;
            await api('PUT', `/api/students/${studentId}/report-meta`, body); toast('Remarks saved'); load();
          },
        }));
      } catch (e) { mount(m.body, html`<div class="empty">${e.message}</div>`); }
    }
    load();
  };

  /* ---------- score entry ---------- */
  async function scoreTab(body, options, ctx) {
    if (!options.length) { mount(body, html`<div class="empty">No classes or subjects are assigned to you for score entry yet. The administrator can assign subjects under Academics.</div>`); return; }
    const school = SF.me.school;
    const pref = SF.store.persist('results', { classId: 0, subjectId: 0, term: 0 });
    const state = { classId: Number(ctx.query.get('class_id')) || pref.classId || options[0].id, subjectId: pref.subjectId, term: pref.term || school.current_term || 1, year: school.academic_year || '' };
    const clsOf = () => options.find((c) => c.id === state.classId) || options[0];
    state.classId = clsOf().id;
    state.subjectId = clsOf().subjects.some((s) => s.id === state.subjectId) ? state.subjectId : clsOf().subjects[0].id;
    const remember = () => { pref.classId = state.classId; pref.subjectId = state.subjectId; pref.term = state.term; };
    remember();

    mount(body, html`<div class="toolbar">
        <select id="cls" aria-label="Class">${options.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>
        <select id="sub" aria-label="Subject"></select>
        <select id="term" aria-label="Term">${[1, 2, 3].map((t) => html`<option value="${t}">Term ${t}</option>`)}</select>
        <input id="year" value="${state.year}" style="max-width:120px" aria-label="Academic year"></div><div id="sheet"></div>`);
    body.querySelector('#cls').value = String(state.classId);
    body.querySelector('#term').value = String(state.term);
    const fillSubjects = () => {
      const sel = body.querySelector('#sub');
      mount(sel, html`${clsOf().subjects.map((s) => html`<option value="${s.id}">${s.name}</option>`)}`);
      if (!clsOf().subjects.some((s) => s.id === state.subjectId)) state.subjectId = clsOf().subjects[0].id;
      sel.value = String(state.subjectId);
    };
    fillSubjects();
    const sheet = body.querySelector('#sheet');

    async function load() {
      try {
        const d = await api('GET', '/api/results' + qs({ class_id: state.classId, subject_id: state.subjectId, term: state.term, year: state.year }));
        const key = draftKey(state);
        const draft = readDraft(key) || {};
        const vals = new Map(d.records.map((r) => [r.student_id, { ca: r.ca_score, exam: r.exam_score }]));
        let restored = false;
        for (const [id, v] of Object.entries(draft)) if (vals.has(Number(id))) { vals.set(Number(id), v); restored = true; }
        if (!d.records.length) { mount(sheet, html`<section class="panel"><div class="empty">No active students in this class.</div></section>`); return; }
        const totalCell = (v) => {
          if (v.ca === null || v.ca === '' || v.exam === null || v.exam === '' || v.ca === undefined || v.exam === undefined) return html`<span class="muted">—</span>`;
          const t = Math.round((Number(v.ca) + Number(v.exam)) * 10) / 10; const g = gradeOf(t, d.scale);
          return html`<b>${t}</b> <span class="badge ${t >= 50 ? 'green' : 'red'}">${g.grade}</span>`;
        };
        mount(sheet, html`<section class="panel">
          ${d.published ? html`<div class="notice">These results are published to parents and locked. Ask school leadership to unpublish them to make changes.</div>` : ''}
          ${restored ? html`<div class="notice info">Unsaved scores from earlier were restored. Press Save to keep them.</div>` : ''}
          <div class="page-actions"><span class="muted small">Class score out of <b>${d.ca_max}</b> · Exam out of <b>${d.exam_max}</b>. Leave a box empty if not yet available.</span><span class="spacer"></span>
            ${d.published ? '' : html`<button class="btn btn-primary" id="save">Save scores</button>`}</div>
          ${table([
            { label: 'Adm. no.', render: (r) => r.admission_no }, { label: 'Student', render: (r) => html`<b>${r.first_name} ${r.last_name}</b>` },
            { label: `Class score`, render: (r) => html`<input type="number" inputmode="decimal" min="0" max="${d.ca_max}" step="0.5" data-sid="${r.student_id}" data-f="ca" value="${vals.get(r.student_id).ca ?? ''}" ${d.published ? raw('disabled') : ''}>` },
            { label: `Exam score`, render: (r) => html`<input type="number" inputmode="decimal" min="0" max="${d.exam_max}" step="0.5" data-sid="${r.student_id}" data-f="exam" value="${vals.get(r.student_id).exam ?? ''}" ${d.published ? raw('disabled') : ''}>` },
            { label: 'Total', cls: 'num', render: (r) => html`<span data-total="${r.student_id}">${totalCell(vals.get(r.student_id))}</span>` },
          ], d.records)}</section>`);
        sheet.querySelectorAll('input[data-sid]').forEach((i) => i.addEventListener('input', () => {
          const id = Number(i.dataset.sid); const v = vals.get(id);
          v[i.dataset.f] = i.value === '' ? null : Number(i.value);
          writeDraft(key, Object.fromEntries(vals));
          mount(sheet.querySelector(`[data-total="${id}"]`), totalCell(v));
        }));
        const save = sheet.querySelector('#save');
        if (save) save.addEventListener('click', async () => {
          try {
            const r = await SF.ui.busy(save, () => api('PUT', '/api/results', { class_id: state.classId, subject_id: state.subjectId, term: state.term, academic_year: state.year,
              records: [...vals].map(([student_id, v]) => ({ student_id, ca_score: v.ca, exam_score: v.exam })) }));
            clearDraft(key); toast(`Saved ${r.saved} students`);
          } catch (e) { fail(e); }
        });
      } catch (e) { mount(sheet, html`<section class="panel"><div class="empty">${e.message}</div></section>`); }
    }
    body.querySelector('#cls').addEventListener('change', (e) => { state.classId = Number(e.target.value); fillSubjects(); remember(); load(); });
    body.querySelector('#sub').addEventListener('change', (e) => { state.subjectId = Number(e.target.value); remember(); load(); });
    body.querySelector('#term').addEventListener('change', (e) => { state.term = Number(e.target.value); remember(); load(); });
    body.querySelector('#year').addEventListener('change', (e) => { state.year = e.target.value.trim(); load(); });
    await load();
  }

  /* ---------- class summary (positions), publishing, report cards ---------- */
  async function summaryTab(body, ctx) {
    const classes = (await api('GET', '/api/classes')).filter((c) => SF.me.user.role === 'admin' || SF.me.user.role === 'principal' || c.teacher_id === SF.me.user.id);
    if (!classes.length) { mount(body, html`<div class="empty">Class summaries are available to class teachers and school leadership.</div>`); return; }
    const school = SF.me.school;
    const preferred = classes.find((c) => c.id === Number(ctx.query.get('class_id'))) || classes.find((c) => c.student_count > 0) || classes[0];
    const state = { classId: preferred.id, term: school.current_term || 1, year: school.academic_year || '' };
    mount(body, html`<div class="toolbar">
      <select id="cls" aria-label="Class">${classes.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>
      <select id="term" aria-label="Term">${[1, 2, 3].map((t) => html`<option value="${t}">Term ${t}</option>`)}</select>
      <input id="year" value="${state.year}" style="max-width:120px" aria-label="Academic year"></div><div id="sum"></div>`);
    body.querySelector('#term').value = String(state.term);
    body.querySelector('#cls').value = String(state.classId);
    const box = body.querySelector('#sum');

    async function load() {
      try {
        const d = await api('GET', '/api/reports/class' + qs({ class_id: state.classId, term: state.term, year: state.year }));
        mount(box, html`<section class="panel">
          <div class="page-actions">${d.published ? badge('Published to parents', 'green') : badge('Not published', 'amber')}<span class="spacer"></span>
            ${SF.can('results:publish') ? html`<button class="btn ${d.published ? 'btn-secondary' : 'btn-primary'}" id="pub">${d.published ? 'Unpublish' : 'Publish report cards to parents'}</button>` : ''}
            ${SF.can('export:read') ? html`<a class="btn btn-secondary" href="/api/export/results.csv">Export results CSV</a>` : ''}</div>
          ${table([
            { label: 'Pos.', cls: 'num', render: (s) => (s.position ? ordinal(s.position) : '—') },
            { label: 'Student', render: (s) => html`<b>${s.name}</b><br><span class="muted small">${s.admission_no}</span>` },
            { label: 'Subjects', cls: 'num', render: (s) => s.subjects }, { label: 'Total', cls: 'num', render: (s) => (s.total === null ? '—' : s.total) },
            { label: 'Average', cls: 'num', render: (s) => (s.average === null ? '—' : s.average) }, { label: 'Grade', render: (s) => s.grade || '—' },
            { label: '', cls: 'num', render: (s) => html`<button class="btn btn-secondary btn-sm" data-rc="${s.student_id}">Report card</button>` },
          ], d.students, { empty: 'No students in this class.' })}</section>`);
        box.querySelectorAll('[data-rc]').forEach((b) => b.addEventListener('click', () => SF.showReportCard(Number(b.dataset.rc), { term: state.term, year: state.year })));
        const pub = box.querySelector('#pub');
        if (pub) pub.addEventListener('click', async () => {
          const on = !d.published;
          if (on && !(await confirmBox({ title: 'Publish report cards?', message: `Parents of ${d.students.length} students will be able to see Term ${state.term} report cards, and scores will be locked.`, confirmLabel: 'Publish' }))) return;
          try { await api('POST', '/api/reports/publish', { class_id: state.classId, term: state.term, academic_year: state.year, publish: on }); toast(on ? 'Report cards published' : 'Unpublished'); load(); } catch (e) { fail(e); }
        });
      } catch (e) { mount(box, html`<section class="panel"><div class="empty">${e.message}</div></section>`); }
    }
    body.querySelector('#cls').addEventListener('change', (e) => { state.classId = Number(e.target.value); load(); });
    body.querySelector('#term').addEventListener('change', (e) => { state.term = Number(e.target.value); load(); });
    body.querySelector('#year').addEventListener('change', (e) => { state.year = e.target.value.trim(); load(); });
    await load();
  }

  SF.views.results = {
    title: 'Exams & Results',
    async render(el, args, ctx) {
      const options = await api('GET', '/api/results/options');
      mount(el, html`<div class="tabs"><button data-tab="scores">Enter scores</button><button data-tab="summary">Class summary & report cards</button></div><div id="tab"></div>`);
      const tab = el.querySelector('#tab');
      const show = async (name) => {
        el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
        try { await (name === 'scores' ? scoreTab(tab, options, ctx) : summaryTab(tab, ctx)); } catch (e) { fail(e); }
      };
      el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
      await show(ctx.query.get('tab') === 'summary' ? 'summary' : 'scores');
    },
  };
})();
