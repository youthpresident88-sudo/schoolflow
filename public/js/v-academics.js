(function () {
  const SF = window.SF;
  const { api } = SF;
  const { html, mount, table, toast, fail, formModal, confirmBox, modal, cap } = SF.ui;

  async function staffOptions() {
    if (!SF.can('staff:read')) return [];
    return (await api('GET', '/api/staff')).filter((s) => s.active).map((s) => ({ value: s.id, label: `${s.name} (${cap(s.role)})` }));
  }

  async function classForm(cls, onDone) {
    const teachers = await staffOptions();
    formModal({
      title: cls ? 'Edit class' : 'Add class', submitLabel: cls ? 'Save' : 'Add class', values: cls || {},
      fields: [
        { name: 'name', label: 'Class name', required: true, full: true, placeholder: 'Primary 4' },
        { name: 'level', label: 'Level / section', full: true, placeholder: 'Upper primary' },
        { name: 'teacher_id', label: 'Class teacher', type: 'select', placeholder: 'Not assigned', options: teachers, full: true, help: 'The class teacher takes attendance and writes report card remarks.' },
      ],
      onSubmit: async (d) => {
        const body = { name: d.name, level: d.level, teacher_id: d.teacher_id };
        if (cls) await api('PUT', `/api/classes/${cls.id}`, body); else await api('POST', '/api/classes', body);
        toast(cls ? 'Class updated' : 'Class added');
        onDone();
      },
    });
  }

  async function subjectsModal(cls, onDone) {
    const [subjects, assigned, teachers] = await Promise.all([api('GET', '/api/subjects'), api('GET', `/api/classes/${cls.id}/subjects`), staffOptions()]);
    const byId = new Map(assigned.map((a) => [a.subject_id, a]));
    const m = modal({ title: `${cls.name}: subjects & teachers`, wide: true, content: html`
      <p class="muted small">Tick the subjects this class studies and choose who teaches each one. Subject teachers can then enter scores for their subject.</p>
      <div class="table-wrap"><table><thead><tr><th>Subject</th><th>Teacher</th></tr></thead><tbody>
        ${subjects.map((s) => html`<tr><td><label style="margin:0;display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" style="width:auto;margin:0" data-sub="${s.id}" ${byId.has(s.id) ? SF.ui.raw('checked') : ''}> ${s.name}</label></td>
          <td><select data-teacher="${s.id}" style="margin:0"><option value="">—</option>${teachers.map((t) => html`<option value="${t.value}" ${byId.get(s.id)?.teacher_id === t.value ? SF.ui.raw('selected') : ''}>${t.label}</option>`)}</select></td></tr>`)}
      </tbody></table></div><div class="form-error" role="alert"></div>
      <div class="form-actions"><button class="btn btn-secondary" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button></div>` });
    m.body.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.body.querySelector('[data-save]').addEventListener('click', async () => {
      const assignments = [...m.body.querySelectorAll('[data-sub]')].filter((c) => c.checked).map((c) => ({
        subject_id: Number(c.dataset.sub), teacher_id: m.body.querySelector(`[data-teacher="${c.dataset.sub}"]`).value || null }));
      try { await api('PUT', `/api/classes/${cls.id}/subjects`, { assignments }); toast('Subjects saved'); m.close(); onDone(); }
      catch (e) { m.body.querySelector('.form-error').textContent = e.message; }
    });
  }

  SF.views.academics = {
    title: 'Academics',
    async render(el) {
      const [classes, subjects] = await Promise.all([api('GET', '/api/classes'), api('GET', '/api/subjects')]);
      const w = SF.can('classes:write');
      mount(el, html`
        <section class="panel"><div class="panel-head"><h2>Classes</h2>${w ? html`<button class="btn btn-primary btn-sm" id="addClass">+ Add class</button>` : ''}</div>
          ${table([
            { label: 'Class', render: (c) => html`<b>${c.name}</b>${c.level ? html`<br><span class="muted small">${c.level}</span>` : ''}` },
            { label: 'Class teacher', render: (c) => c.teacher_name || html`<span class="muted">Not assigned</span>` },
            { label: 'Students', cls: 'num', render: (c) => c.student_count },
            { label: '', cls: 'num', render: (c) => html`<div class="row-actions"><a class="btn btn-secondary btn-sm" href="#/students?class_id=${c.id}">Students</a>${w ? html`<button class="btn btn-secondary btn-sm" data-subs="${c.id}">Subjects</button><button class="btn btn-secondary btn-sm" data-edit="${c.id}">Edit</button><button class="btn btn-danger btn-sm" data-del="${c.id}">Delete</button>` : ''}</div>` },
          ], classes, { empty: 'No classes yet.' })}</section>
        <section class="panel"><div class="panel-head"><h2>Subjects</h2>${w ? html`<button class="btn btn-secondary btn-sm" id="addSub">+ Add subject</button>` : ''}</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">${subjects.map((s) => html`<span class="badge blue" style="font-size:12px;padding:6px 11px">${s.name}${w ? html` <button class="link" data-delsub="${s.id}" aria-label="Delete ${s.name}" style="color:#991b1b;margin-left:4px">×</button>` : ''}</span>`)}</div></section>`);

      const reload = () => SF.reload();
      const find = (id) => classes.find((c) => c.id === Number(id));
      if (w) {
        el.querySelector('#addClass').addEventListener('click', () => classForm(null, reload));
        el.querySelector('#addSub').addEventListener('click', () => formModal({ title: 'Add subject', fields: [{ name: 'name', label: 'Subject name', required: true, full: true }], submitLabel: 'Add subject',
          onSubmit: async (d) => { await api('POST', '/api/subjects', { name: d.name }); toast('Subject added'); reload(); } }));
        el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => classForm(find(b.dataset.edit), reload)));
        el.querySelectorAll('[data-subs]').forEach((b) => b.addEventListener('click', () => subjectsModal(find(b.dataset.subs), reload)));
        el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
          const c = find(b.dataset.del);
          if (!(await confirmBox({ message: `Delete ${c.name}? This only works when the class has no students.`, confirmLabel: 'Delete', danger: true }))) return;
          try { await api('DELETE', `/api/classes/${c.id}`); toast('Class deleted'); reload(); } catch (e) { fail(e); }
        }));
        el.querySelectorAll('[data-delsub]').forEach((b) => b.addEventListener('click', async () => {
          const s = subjects.find((x) => x.id === Number(b.dataset.delsub));
          if (!(await confirmBox({ message: `Delete the subject “${s.name}”? Subjects that already have results cannot be deleted.`, confirmLabel: 'Delete', danger: true }))) return;
          try { await api('DELETE', `/api/subjects/${s.id}`); toast('Subject deleted'); reload(); } catch (e) { fail(e); }
        }));
      }
    },
  };
})();
