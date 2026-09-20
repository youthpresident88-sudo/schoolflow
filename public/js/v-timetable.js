(function () {
  const SF = window.SF;
  const { api, qs } = SF;
  const { html, mount, toast, fail, formModal, confirmBox, cap } = SF.ui;

  const DAYS = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday']];

  SF.views.timetable = {
    title: 'Timetable',
    async render(el) {
      const w = SF.can('timetable:write');
      const lead = SF.me.user.role === 'admin' || SF.me.user.role === 'principal';
      const [classes, subjects, staff] = await Promise.all([api('GET', '/api/classes'), api('GET', '/api/subjects'), SF.can('staff:read') ? api('GET', '/api/staff') : Promise.resolve([])]);
      const teachers = staff.filter((s) => s.active);
      const state = { mode: lead ? 'class' : 'teacher', classId: classes[0] ? classes[0].id : 0, teacherId: SF.me.user.id };

      mount(el, html`<div class="toolbar">
        ${lead ? html`<div class="tabs" style="margin:0"><button data-mode="class">By class</button><button data-mode="teacher">By teacher</button></div>` : ''}
        <select id="cls" aria-label="Class">${classes.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>
        <select id="tch" aria-label="Teacher">${teachers.map((t) => html`<option value="${t.id}">${t.name}</option>`)}</select>
        <span style="flex:1"></span>${w ? html`<button class="btn btn-primary" id="add">+ Add lesson</button>` : ''}</div>
        <section class="panel"><div id="grid"></div></section>`);
      const grid = el.querySelector('#grid');
      el.querySelector('#tch').value = String(state.teacherId);

      function lessonForm(lesson) {
        formModal({
          title: lesson ? 'Edit lesson' : 'Add lesson', submitLabel: lesson ? 'Save' : 'Add lesson', values: lesson || { class_id: state.classId },
          fields: [
            { name: 'class_id', label: 'Class', type: 'select', required: true, options: classes.map((c) => ({ value: c.id, label: c.name })) },
            { name: 'day', label: 'Day', type: 'select', required: true, options: DAYS.map(([v, l]) => ({ value: v, label: l })), default: 1 },
            { name: 'subject_id', label: 'Subject', type: 'select', placeholder: '—', options: subjects.map((s) => ({ value: s.id, label: s.name })) },
            { name: 'teacher_id', label: 'Teacher', type: 'select', placeholder: '—', options: teachers.map((t) => ({ value: t.id, label: t.name })) },
            { name: 'start_time', label: 'Starts', type: 'time', required: true }, { name: 'end_time', label: 'Ends', type: 'time', required: true },
            { name: 'room', label: 'Room', full: true },
          ],
          onSubmit: async (d) => {
            if (lesson) await api('PUT', `/api/timetable/${lesson.id}`, d); else await api('POST', '/api/timetable', d);
            toast(lesson ? 'Lesson updated' : 'Lesson added'); load();
          },
        });
      }

      async function load() {
        el.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
        el.querySelector('#cls').classList.toggle('hidden', state.mode !== 'class');
        el.querySelector('#tch').classList.toggle('hidden', state.mode !== 'teacher' || !lead);
        try {
          const rows = await api('GET', '/api/timetable' + qs(state.mode === 'class' ? { class_id: state.classId } : { teacher_id: state.teacherId }));
          mount(grid, rows.length || w ? html`<div class="tt">${DAYS.slice(0, 5).map(([d, label]) => html`<div class="tt-day"><h4>${label}</h4>
            ${rows.filter((r) => r.day === d).map((r) => html`<div class="tt-slot"><b>${r.subject || 'Lesson'}</b>${r.start_time}–${r.end_time}${state.mode === 'teacher' ? html`<br>${r.class_name}` : r.teacher_name ? html`<br>${r.teacher_name}` : ''}${r.room ? html`<br><span class="muted">${r.room}</span>` : ''}
              ${w ? html`<div style="margin-top:6px"><button class="link" data-edit="${r.id}">Edit</button> · <button class="link" style="color:#991b1b" data-del="${r.id}">Remove</button></div>` : ''}</div>`)}</div>`)}</div>
            ${rows.some((r) => r.day === 6) ? html`<h4>Saturday</h4>${rows.filter((r) => r.day === 6).map((r) => html`<div class="tt-slot"><b>${r.subject || 'Lesson'}</b>${r.start_time}–${r.end_time}</div>`)}` : ''}` : html`<div class="empty">No lessons scheduled.</div>`);
          grid.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => lessonForm(rows.find((r) => r.id === Number(b.dataset.edit)))));
          grid.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
            if (!(await confirmBox({ message: 'Remove this lesson from the timetable?', confirmLabel: 'Remove', danger: true }))) return;
            try { await api('DELETE', `/api/timetable/${b.dataset.del}`); toast('Removed'); load(); } catch (e) { fail(e); }
          }));
        } catch (e) { fail(e); }
      }
      el.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { state.mode = b.dataset.mode; load(); }));
      el.querySelector('#cls').addEventListener('change', (e) => { state.classId = Number(e.target.value); load(); });
      el.querySelector('#tch').addEventListener('change', (e) => { state.teacherId = Number(e.target.value); load(); });
      if (w) el.querySelector('#add').addEventListener('click', () => lessonForm(null));
      await load();
    },
  };
})();
