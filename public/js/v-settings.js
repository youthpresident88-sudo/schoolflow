(function () {
  const SF = window.SF;
  const { api } = SF;
  const { html, raw, mount, toast, fail, table, fmtDate, esc } = SF.ui;

  const TYPES = ['Basic School', 'JHS', 'SHS', 'Private School', 'Other'];

  SF.views.settings = {
    title: 'Settings',
    async render(el) {
      const s = await api('GET', '/api/settings');
      const w = SF.can('settings:write');
      const ro = w ? '' : raw('disabled');
      const img = { logo: undefined, cover: undefined }; // undefined = unchanged, '' = remove, data URL = replace
      const scale = s.grading_scale.map((g) => ({ ...g }));
      const base = location.origin;

      mount(el, html`
        ${w ? '' : html`<div class="notice info">You can view these settings. Only the administrator can change them.</div>`}
        <section class="panel"><div class="panel-head"><h2>School profile & branding</h2></div>
          <form id="profile"><div class="fgrid">
            <label>School name<input name="name" value="${s.name}" required ${ro}></label>
            <label>Type<select name="type" ${ro}>${TYPES.map((t) => html`<option ${t === s.type ? raw('selected') : ''}>${t}</option>`)}</select></label>
            <label>Location<input name="location" value="${s.location || ''}" ${ro}></label>
            <label>Motto<input name="motto" value="${s.motto || ''}" ${ro}></label>
            <label>School phone<input name="phone" type="tel" value="${s.phone || ''}" ${ro}></label>
            <label>School email<input name="email" type="email" value="${s.email || ''}" ${ro}></label>
            <label>Primary colour<input name="primary_color" type="color" value="${s.primary_color}" ${ro}></label>
            <label>Accent colour<input name="secondary_color" type="color" value="${s.secondary_color}" ${ro}></label>
            <label>Logo<input type="file" id="logo" accept="image/*" ${ro}><span class="help">PNG or JPEG. Shown on report cards and receipts.</span></label>
            <label>Login background<input type="file" id="cover" accept="image/*" ${ro}><span class="help">Optional photo of your school.</span></label>
            <div class="full" id="imgs" style="display:flex;gap:14px;align-items:center;margin-top:8px"></div>
            <label class="full" style="display:flex;gap:10px;align-items:center"><input type="checkbox" name="admissions_open" value="1" style="width:auto;margin:0" ${s.admissions_open ? raw('checked') : ''} ${ro}> Accept online admission applications</label>
          </div>${w ? html`<div class="form-actions"><button class="btn btn-primary" type="submit">Save profile</button></div>` : ''}</form></section>

        <section class="panel"><div class="panel-head"><h2>Academic year & assessment</h2></div>
          <form id="academic"><div class="fgrid">
            <label>Current academic year<input name="academic_year" value="${s.academic_year || ''}" placeholder="2026/2027" required ${ro}></label>
            <label>Current term<select name="current_term" ${ro}>${[1, 2, 3, 4].map((t) => html`<option value="${t}" ${t === s.current_term ? raw('selected') : ''}>Term ${t}</option>`)}</select></label>
            <label>Class score (continuous assessment) out of<input name="ca_max" type="number" min="0" max="100" value="${s.ca_max}" ${ro}><span class="help">The exam score makes up the rest of the 100 marks, e.g. 30 + 70. Ghana schools commonly use 30/70 or 50/50.</span></label>
            <div class="full"><b style="font-size:13px">Grading scale</b><span class="help">Anyone scoring at least the “from” mark gets that grade.</span><div id="scale"></div>${w ? html`<button type="button" class="btn btn-secondary btn-sm" id="addGrade" style="margin-top:8px">+ Add grade</button>` : ''}</div>
          </div>${w ? html`<div class="form-actions"><button class="btn btn-primary" type="submit">Save academic settings</button></div>` : ''}</form></section>

        <section class="panel"><div class="panel-head"><h2>Term dates · ${s.academic_year || ''}</h2></div>
          <p class="muted small">Dates let report cards show attendance for the term and tell parents when school reopens.</p>
          ${s.terms.map((t) => html`<form class="toolbar" data-term="${t.term}"><b style="min-width:60px">Term ${t.term}</b>
            <label style="margin:0">Starts <input type="date" name="start_date" value="${t.start_date || ''}" ${ro}></label>
            <label style="margin:0">Ends <input type="date" name="end_date" value="${t.end_date || ''}" ${ro}></label>
            <label style="margin:0">Next term begins <input type="date" name="next_term_begins" value="${t.next_term_begins || ''}" ${ro}></label>
            ${w ? html`<button class="btn btn-secondary btn-sm" type="submit">Save</button>` : ''}</form>`)}</section>

        <section class="panel"><div class="panel-head"><h2>Links & data</h2></div>
          <div class="kv" style="grid-template-columns:1fr"><div><small>Online admission form (share with parents)</small><b><a href="${base}/apply.html?school=${s.slug}">${base}/apply.html?school=${s.slug}</a></b></div>
            <div><small>Branded sign-in page</small><b><a href="${base}/login.html?school=${s.slug}">${base}/login.html?school=${s.slug}</a></b></div></div>
          ${SF.can('export:read') ? html`<div class="page-actions" style="margin-top:16px"><a class="btn btn-secondary" href="/api/export/all">Download all school data (JSON)</a><a class="btn btn-secondary" href="/api/export/students.csv">Students CSV</a><a class="btn btn-secondary" href="/api/export/invoices.csv">Invoices CSV</a><a class="btn btn-secondary" href="/api/export/results.csv">Results CSV</a></div>
          <p class="muted small">Your data belongs to your school. Exports never include passwords.</p>` : ''}</section>`);

      /* logo / cover previews */
      const imgs = el.querySelector('#imgs');
      const paintImgs = () => {
        const logo = img.logo === undefined ? s.logo : img.logo; const cover = img.cover === undefined ? s.cover : img.cover;
        mount(imgs, html`${logo ? html`<span><img src="${logo}" alt="Logo preview" style="height:56px;border:1px solid var(--line);border-radius:10px;padding:4px"> ${w ? html`<button type="button" class="link" data-clear="logo">Remove logo</button>` : ''}</span>` : ''}
          ${cover ? html`<span><img src="${cover}" alt="Background preview" style="height:56px;border-radius:10px"> ${w ? html`<button type="button" class="link" data-clear="cover">Remove background</button>` : ''}</span>` : ''}`);
        imgs.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => { img[b.dataset.clear] = ''; paintImgs(); }));
      };
      paintImgs();
      const pick = (id, key, dim, mime, q) => el.querySelector(id).addEventListener('change', async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { img[key] = await SF.imageToDataUrl(f, dim, mime, q); paintImgs(); } catch (err) { fail(err); e.target.value = ''; }
      });
      pick('#logo', 'logo', 256, 'image/png'); pick('#cover', 'cover', 1600, 'image/jpeg', 0.82);

      /* grading scale editor */
      const scaleBox = el.querySelector('#scale');
      const paintScale = () => {
        mount(scaleBox, html`${scale.map((g, i) => html`<div class="toolbar" style="margin-bottom:6px"><input type="number" min="0" max="100" value="${g.min}" data-i="${i}" data-k="min" style="width:80px" aria-label="From mark" ${ro}>
          <input value="${g.grade}" data-i="${i}" data-k="grade" style="width:70px" maxlength="6" aria-label="Grade" ${ro}><input value="${g.remark || ''}" data-i="${i}" data-k="remark" placeholder="Remark" aria-label="Remark" ${ro}>
          ${w && scale.length > 2 ? html`<button type="button" class="btn btn-danger btn-sm" data-rm="${i}">×</button>` : ''}</div>`)}`);
        scaleBox.querySelectorAll('[data-i]').forEach((inp) => inp.addEventListener('input', () => { const g = scale[Number(inp.dataset.i)]; g[inp.dataset.k] = inp.dataset.k === 'min' ? Number(inp.value) : inp.value; }));
        scaleBox.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { scale.splice(Number(b.dataset.rm), 1); paintScale(); }));
      };
      paintScale();
      const add = el.querySelector('#addGrade');
      if (add) add.addEventListener('click', () => { scale.push({ min: 0, grade: '', remark: '' }); paintScale(); });

      if (!w) return;
      const save = async (body, msg) => { try { await api('PUT', '/api/settings', body); toast(msg); await SF.reloadMe(); } catch (e) { fail(e); } };
      el.querySelector('#profile').addEventListener('submit', (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(e.target));
        const body = { name: d.name, type: d.type, location: d.location, motto: d.motto, phone: d.phone, email: d.email, primary_color: d.primary_color, secondary_color: d.secondary_color, admissions_open: !!d.admissions_open };
        if (img.logo !== undefined) body.logo = img.logo;
        if (img.cover !== undefined) body.cover = img.cover;
        save(body, 'Profile saved');
      });
      el.querySelector('#academic').addEventListener('submit', (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(e.target));
        save({ academic_year: d.academic_year, current_term: Number(d.current_term), ca_max: Number(d.ca_max), grading_scale: scale.map((g) => ({ min: g.min, grade: g.grade, remark: g.remark })) }, 'Academic settings saved');
      });
      el.querySelectorAll('form[data-term]').forEach((f) => f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(f));
        try { await api('PUT', '/api/terms', { academic_year: s.academic_year, term: Number(f.dataset.term), start_date: d.start_date, end_date: d.end_date, next_term_begins: d.next_term_begins }); toast(`Term ${f.dataset.term} dates saved`); } catch (err) { fail(err); }
      }));
    },
  };
})();
