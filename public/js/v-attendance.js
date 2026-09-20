(function () {
  const SF = window.SF;
  const { api, qs } = SF;
  const { html, raw, mount, table, pct, toast, fail, todayStr, fmtDate, bar } = SF.ui;

  const OPTS = [['present', 'Present', 'p'], ['late', 'Late', 'l'], ['absent', 'Absent', 'a'], ['excused', 'Excused', 'e']];
  const draftKey = (c, d) => `sf:att:${SF.me.user.id}:${c}:${d}`;
  const readDraft = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const writeDraft = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } };
  const clearDraft = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

  SF.views.attendance = {
    title: 'Attendance',
    async render(el, args, ctx) {
      let classes = await api('GET', '/api/classes');
      const lead = SF.me.user.role === 'admin' || SF.me.user.role === 'principal';
      if (!lead) classes = classes.filter((c) => c.teacher_id === SF.me.user.id);
      if (!classes.length) {
        mount(el, html`<section class="panel"><div class="empty">${lead ? 'Create a class first (Academics).' : 'You are not the class teacher of any class yet. Ask the administrator to assign you.'}</div></section>`);
        return;
      }
      const pref = SF.store.persist('attendance', { classId: 0 });
      const preferred = classes.find((c) => c.id === Number(ctx.query.get('class_id'))) || classes.find((c) => c.id === pref.classId) || classes.find((c) => c.student_count > 0) || classes[0];
      const state = { classId: preferred.id, date: todayStr(), tab: 'mark' };
      pref.classId = state.classId;

      mount(el, html`
        <div class="toolbar">
          <select id="cls" aria-label="Class">${classes.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>
          <input type="date" id="date" max="${todayStr()}" value="${state.date}" aria-label="Date">
          <div class="tabs" style="margin:0"><button data-tab="mark" class="active">Register</button><button data-tab="report">Last 30 days</button></div>
        </div>
        <section class="panel"><div id="body"></div></section>`);
      el.querySelector('#cls').value = String(state.classId);
      const body = el.querySelector('#body');

      async function loadRegister() {
        const data = await api('GET', '/api/attendance' + qs({ class_id: state.classId, date: state.date }));
        const key = draftKey(state.classId, state.date);
        const draft = readDraft(key);
        const status = new Map(data.records.map((r) => [r.student_id, r.status]));
        let restored = false;
        if (draft) { for (const [id, s] of Object.entries(draft)) if (status.has(Number(id))) { status.set(Number(id), s); restored = true; } }
        if (!data.records.length) { mount(body, html`<div class="empty">No active students in this class.</div>`); return; }

        const summary = () => {
          const c = { present: 0, late: 0, absent: 0, excused: 0, none: 0 };
          for (const s of status.values()) c[s || 'none']++;
          return html`<b>${c.present}</b> present · <b>${c.late}</b> late · <b>${c.absent}</b> absent · <b>${c.excused}</b> excused${c.none ? html` · <span class="neg">${c.none} not marked</span>` : ''}`;
        };
        mount(body, html`
          ${restored ? html`<div class="notice info">Unsaved changes from earlier were restored. Press Save to keep them.</div>` : ''}
          <div class="page-actions"><span id="sum" class="small"></span><span class="spacer"></span>
            <button class="btn btn-secondary btn-sm" id="allP">Mark all present</button><button class="btn btn-primary" id="save">Save attendance</button></div>
          ${table([
            { label: 'Adm. no.', render: (r) => r.admission_no },
            { label: 'Student', render: (r) => html`<b>${r.first_name} ${r.last_name}</b>` },
            { label: 'Status', render: (r) => html`<div class="seg" role="radiogroup" aria-label="Status for ${r.first_name}">${OPTS.map(([v, label, k]) => html`<label><input type="radio" name="s${r.student_id}" value="${v}" data-sid="${r.student_id}" ${status.get(r.student_id) === v ? raw('checked') : ''}><span class="${k}">${label}</span></label>`)}</div>` },
          ], data.records)}`);
        const sum = body.querySelector('#sum');
        const paint = () => mount(sum, summary());
        paint();
        body.querySelectorAll('input[type=radio]').forEach((i) => i.addEventListener('change', () => {
          status.set(Number(i.dataset.sid), i.value);
          writeDraft(key, Object.fromEntries([...status].filter(([, v]) => v)));
          paint();
        }));
        body.querySelector('#allP').addEventListener('click', () => {
          body.querySelectorAll('input[value=present]').forEach((i) => { i.checked = true; status.set(Number(i.dataset.sid), 'present'); });
          writeDraft(key, Object.fromEntries([...status].filter(([, v]) => v)));
          paint();
        });
        body.querySelector('#save').addEventListener('click', async (e) => {
          const missing = [...status.values()].filter((v) => !v).length;
          if (missing) { toast(`${missing} student(s) still have no status`, 'error'); return; }
          try {
            await SF.ui.busy(e.target, () => api('PUT', '/api/attendance', { class_id: state.classId, date: state.date, records: [...status].map(([student_id, s]) => ({ student_id, status: s })) }));
            clearDraft(key); toast('Attendance saved');
          } catch (err) { fail(err); }
        });
      }

      async function loadReport() {
        const r = await api('GET', '/api/attendance/report' + qs({ class_id: state.classId }));
        mount(body, html`<p class="muted small">${fmtDate(r.from)} to ${fmtDate(r.to)}</p>${table([
          { label: 'Student', render: (s) => html`<b>${s.first_name} ${s.last_name}</b><br><span class="muted small">${s.admission_no}</span>` },
          { label: 'Present', cls: 'num', render: (s) => s.present }, { label: 'Late', cls: 'num', render: (s) => s.late },
          { label: 'Absent', cls: 'num', render: (s) => s.absent }, { label: 'Excused', cls: 'num', render: (s) => s.excused },
          { label: 'Rate', render: (s) => html`<b>${pct(s.rate)}</b>${s.rate === null ? '' : bar(s.rate)}` },
        ], r.students, { empty: 'No students.' })}`);
      }

      const load = async () => { try { await (state.tab === 'mark' ? loadRegister() : loadReport()); } catch (e) { fail(e); } };
      el.querySelector('#cls').addEventListener('change', (e) => { state.classId = Number(e.target.value); pref.classId = state.classId; load(); });
      el.querySelector('#date').addEventListener('change', (e) => { state.date = e.target.value || todayStr(); load(); });
      el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
        state.tab = b.dataset.tab;
        el.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
        el.querySelector('#date').classList.toggle('hidden', state.tab !== 'mark');
        load();
      }));
      await loadRegister();
    },
  };
})();
