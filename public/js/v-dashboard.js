(function () {
  const SF = window.SF;
  const { api } = SF;
  const { html, mount, money, pct, ago, fmtDate } = SF.ui;

  const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
  const dayLetter = (d) => ['S', 'M', 'T', 'W', 'T', 'F', 'S'][new Date(d + 'T00:00:00').getDay()];
  const ACTION_ICON = { student: '👤', payment: '💳', announcement: '📢', attendance: '✅', results: '📝', invoices: '🧾', staff: '👥', class: '📚', settings: '⚙️', task: '📌', event: '🗓️', admission: '📥', students: '🎓', reports: '📄', report: '📄', fees: '💳', timetable: '🗓️', portal: '👪', export: '⬇️', subject: '📚', terms: '🗓️' };
  const icon = (action) => ACTION_ICON[String(action).split('.')[0]] || '•';

  SF.views.dashboard = {
    title: 'Dashboard',
    async render(el, args, ctx) {
      const d = await api('GET', '/api/dashboard');
      const first = SF.me.user.name.split(' ')[0];
      ctx.setHeader(`${greeting()}, ${first} 👋`);

      const stats = [html`<div class="stat"><small>Students</small><b>${d.students.toLocaleString()}</b><span>Active students</span></div>`];
      if (d.attendance) {
        stats.push(html`<div class="stat"><small>Attendance today</small><b>${pct(d.attendance.rate)}</b><span>${d.attendance.marked ? `${d.attendance.absent} absent · ${d.attendance.marked} marked` : 'Not marked yet'}</span></div>`);
      }
      if (d.fees) stats.push(html`<div class="stat"><small>Fees collected</small><b>${money(d.fees.collected)}</b><span>${pct(d.fees.rate)} of ${money(d.fees.billed)} billed</span></div>`);
      else if (d.academic_average !== undefined) stats.push(html`<div class="stat"><small>Academic average</small><b>${d.academic_average === null ? '—' : d.academic_average}</b><span>Term ${d.period.term}, ${d.period.year}</span></div>`);
      if (d.staff !== undefined) stats.push(html`<div class="stat"><small>Staff</small><b>${d.staff}</b><span>Teachers & staff</span></div>`);
      else if (d.tasks) stats.push(html`<div class="stat"><small>My tasks</small><b>${d.tasks.open}</b><span>${d.tasks.overdue ? `${d.tasks.overdue} overdue` : 'Open tasks'}</span></div>`);

      const actions = [
        ['students:write', '#/students/new', '+ Add student'], ['attendance:write', '#/attendance', '✓ Take attendance'],
        ['fees:write', '#/fees', '💳 Record payment'], ['results:write', '#/results', '📝 Enter results'], ['announcements:write', '#/communication', '📢 Announcement'],
      ].filter(([perm]) => SF.can(perm));

      const alerts = [];
      if (d.fees && d.fees.students_owing) alerts.push(html`<li><a href="#/fees"><b>${d.fees.students_owing}</b> students have outstanding fees</a></li>`);
      if (d.applicants) alerts.push(html`<li><a href="#/students?status=applicant"><b>${d.applicants}</b> admission ${d.applicants === 1 ? 'application awaits' : 'applications await'} review</a></li>`);
      if (d.attendance && d.attendance.absent) alerts.push(html`<li><a href="#/attendance"><b>${d.attendance.absent}</b> students absent today</a></li>`);
      if (d.classes_unmarked) alerts.push(html`<li><a href="#/attendance"><b>${d.classes_unmarked}</b> ${d.classes_unmarked === 1 ? 'class has' : 'classes have'} not taken attendance today</a></li>`);
      if (d.tasks && d.tasks.overdue) alerts.push(html`<li><a href="#/staff"><b>${d.tasks.overdue}</b> overdue ${d.tasks.overdue === 1 ? 'task' : 'tasks'}</a></li>`);
      if (d.unread_messages) alerts.push(html`<li><a href="#/messages"><b>${d.unread_messages}</b> unread ${d.unread_messages === 1 ? 'message' : 'messages'}</a></li>`);

      const trend = d.attendance_trend || [];
      mount(el, html`
        <div class="stat-grid">${stats}</div>
        ${actions.length ? html`<div class="quick"><h2>Quick actions</h2><div>${actions.map(([, href, label]) => html`<button data-go="${href}">${label}</button>`)}</div></div>` : ''}
        ${d.my_classes && d.my_classes.length ? html`<section class="panel"><div class="panel-head"><h2>My classes</h2></div>
          ${d.my_classes.map((c) => html`<div class="list-row"><b>${c.name}</b><span>${c.student_count} students · <a href="#/attendance?class_id=${c.id}">Attendance</a> · <a href="#/results?class_id=${c.id}">Results</a></span></div>`)}</section>` : ''}
        <div class="dash-grid">
          <section class="panel"><div class="panel-head"><h2>School overview</h2><span>Term ${d.period.term} · ${d.period.year}</span></div>
            <div class="overview-row">
              <div><small>Attendance</small><strong>${d.attendance ? pct(d.attendance.rate) : '—'}</strong></div>
              <div><small>Fee collection</small><strong>${d.fees ? pct(d.fees.rate) : '—'}</strong></div>
              <div><small>Academic average</small><strong>${d.academic_average === undefined || d.academic_average === null ? '—' : d.academic_average}</strong></div>
            </div>
            ${trend.length ? html`<p class="muted small" style="margin:14px 0 0">Attendance, last 7 days</p>
              <div class="fake-chart">${trend.map((t) => html`<div class="chart-col"><i style="height:${t.rate === null ? 3 : Math.max(3, t.rate)}%;${t.rate === null ? 'opacity:.2' : ''}" title="${fmtDate(t.date)}: ${t.rate === null ? 'no data' : t.rate + '%'}"></i>${dayLetter(t.date)}</div>`)}</div>` : ''}
          </section>
          <section class="panel"><div class="panel-head"><h2>Needs attention</h2><span>Today</span></div>
            <ul class="alerts">${alerts.length ? alerts : html`<li>You're all caught up ✓</li>`}</ul></section>
        </div>
        <div class="dash-grid">
          ${d.recent ? html`<section class="panel"><div class="panel-head"><h2>Recent activity</h2><a class="muted small" href="#/staff?tab=activity">View all</a></div>
            <div class="activity">${d.recent.length ? d.recent.map((a) => html`<div><span style="color:inherit">${icon(a.action)} ${a.summary}${a.user_name ? html` <span>· ${a.user_name}</span>` : ''}</span><span>${ago(a.created_at)}</span></div>`) : html`<div>No activity yet</div>`}</div></section>` : ''}
          ${d.events ? html`<section class="panel"><div class="panel-head"><h2>Upcoming events</h2><a class="muted small" href="#/communication?tab=events">All events</a></div>
            ${d.events.length ? d.events.map((e) => html`<div class="list-row"><span><b>${e.title}</b>${e.location ? html`<br><span class="muted small">${e.location}</span>` : ''}</span><span class="muted nowrap">${fmtDate(e.start_date)}</span></div>`) : html`<div class="empty">No upcoming events</div>`}</section>` : ''}
        </div>`);
      el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
    },
  };
})();
