(function () {
  const SF = window.SF;
  const { api } = SF;
  const { html, mount, fmtDate, ago, badge, toast, fail, formModal, confirmBox, cap } = SF.ui;

  const lead = () => SF.me.user.role === 'admin' || SF.me.user.role === 'principal';
  const AUD = [{ value: 'all', label: 'Everyone' }, { value: 'parents', label: 'Parents' }, { value: 'staff', label: 'Staff' }, { value: 'students', label: 'Students' }];

  async function announceModal(onDone) {
    const classes = (await api('GET', '/api/classes')).filter((c) => lead() || c.teacher_id === SF.me.user.id);
    if (!classes.length && !lead()) { toast('You can post announcements to your own class once you are assigned as a class teacher', 'error'); return; }
    formModal({
      title: 'New announcement', submitLabel: 'Post', wide: true,
      fields: [
        { name: 'title', label: 'Title', required: true, full: true, max: 120 },
        { name: 'body', label: 'Message', type: 'textarea', required: true, full: true, rows: 5, max: 2000 },
        ...(lead() ? [{ name: 'audience', label: 'Who is it for?', type: 'select', options: AUD, default: 'all' }] : []),
        { name: 'class_id', label: lead() ? 'Only one class? (optional)' : 'Class', type: 'select', required: !lead(), placeholder: lead() ? 'Whole school' : 'Choose…', options: classes.map((c) => ({ value: c.id, label: c.name })) },
        { heading: 'Also send it directly to phones and inboxes' },
        { name: 'sms', label: 'SMS to parents / staff', type: 'checkbox' }, { name: 'email', label: 'Email to parents / staff', type: 'checkbox' },
      ],
      onSubmit: async (d) => {
        const notify = [d.sms && 'sms', d.email && 'email'].filter(Boolean);
        const r = await api('POST', '/api/announcements', { title: d.title, body: d.body, audience: d.audience, class_id: d.class_id, notify });
        toast(notify.length ? `Posted. ${r.queued.sms} SMS and ${r.queued.email} email queued` : 'Announcement posted');
        onDone();
      },
    });
  }

  function eventModal(ev, onDone) {
    formModal({
      title: ev ? 'Edit event' : 'New event', submitLabel: ev ? 'Save' : 'Add event', values: ev || {},
      fields: [
        { name: 'title', label: 'Event', required: true, full: true }, { name: 'start_date', label: 'Starts', type: 'date', required: true }, { name: 'end_date', label: 'Ends (optional)', type: 'date' },
        { name: 'location', label: 'Location', full: true }, { name: 'audience', label: 'Who is invited?', type: 'select', options: AUD, default: 'all', full: true },
        { name: 'description', label: 'Details', type: 'textarea', full: true },
      ],
      onSubmit: async (d) => {
        if (ev) await api('PUT', `/api/events/${ev.id}`, d); else await api('POST', '/api/events', d);
        toast(ev ? 'Event updated' : 'Event added'); onDone();
      },
    });
  }

  SF.views.communication = {
    title: 'Communication',
    async render(el, args, ctx) {
      const pref = SF.store.persist('comms', { tab: 'announcements' });
      if (ctx.query.get('tab') === 'events' || ctx.query.get('tab') === 'announcements') pref.tab = ctx.query.get('tab');
      let tab = pref.tab;
      mount(el, html`<div class="page-actions"><div class="tabs" style="margin:0"><button data-tab="announcements">Announcements</button><button data-tab="events">Events</button></div><span class="spacer"></span><span id="act"></span></div><section class="panel"><div id="body"></div></section>`);
      const body = el.querySelector('#body'); const act = el.querySelector('#act');

      async function show() {
        el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
        try {
          if (tab === 'announcements') {
            const list = await api('GET', '/api/announcements');
            mount(act, SF.can('announcements:write') ? html`<button class="btn btn-primary" id="new">+ New announcement</button>` : '');
            mount(body, list.length ? html`${list.map((a) => html`<div class="list-row"><div><b>${a.title}</b> ${badge(a.class_name ? a.class_name : cap(a.audience))}<p>${a.body}</p><span class="muted small">${a.author || 'School'} · ${ago(a.created_at)}</span></div>
              ${SF.can('announcements:write') && (lead() || a.created_by === SF.me.user.id) ? html`<button class="btn btn-danger btn-sm" data-del="${a.id}">Delete</button>` : ''}</div>`)}` : html`<div class="empty">No announcements yet.</div>`);
            const n = act.querySelector('#new'); if (n) n.addEventListener('click', () => announceModal(show));
            body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
              if (!(await confirmBox({ message: 'Delete this announcement?', confirmLabel: 'Delete', danger: true }))) return;
              try { await api('DELETE', `/api/announcements/${b.dataset.del}`); toast('Deleted'); show(); } catch (e) { fail(e); }
            }));
          } else {
            const list = await api('GET', '/api/events');
            const w = SF.can('events:write');
            mount(act, w ? html`<button class="btn btn-primary" id="new">+ New event</button>` : '');
            mount(body, list.length ? html`${list.map((e) => html`<div class="list-row"><div><b>${e.title}</b> ${badge(cap(e.audience))}<p>${e.description || ''}</p><span class="muted small">${fmtDate(e.start_date)}${e.end_date ? ` – ${fmtDate(e.end_date)}` : ''}${e.location ? ` · ${e.location}` : ''}</span></div>
              ${w ? html`<div class="row-actions"><button class="btn btn-secondary btn-sm" data-edit="${e.id}">Edit</button><button class="btn btn-danger btn-sm" data-del="${e.id}">Delete</button></div>` : ''}</div>`)}` : html`<div class="empty">No upcoming events.</div>`);
            const n = act.querySelector('#new'); if (n) n.addEventListener('click', () => eventModal(null, show));
            body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => eventModal(list.find((x) => x.id === Number(b.dataset.edit)), show)));
            body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
              if (!(await confirmBox({ message: 'Delete this event?', confirmLabel: 'Delete', danger: true }))) return;
              try { await api('DELETE', `/api/events/${b.dataset.del}`); toast('Deleted'); show(); } catch (e) { fail(e); }
            }));
          }
        } catch (e) { fail(e); }
      }
      el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; pref.tab = tab; show(); }));
      await show();
    },
  };
})();
