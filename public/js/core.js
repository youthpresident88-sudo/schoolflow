/* SchoolFlow — dashboard shell: sign-in check, branding, role-based navigation, router */
(function () {
  const SF = window.SF;
  const { api } = SF;
  const { html, mount, toast, fail, formModal, modal, skeleton } = SF.ui;

  const STAFF_NAV = [
    { seg: 'dashboard', label: 'Dashboard', short: 'Home', icon: '🏠', perm: 'dashboard:read' },
    { seg: 'students', label: 'Students', short: 'Students', icon: '👨‍🎓', perm: 'students:read' },
    { seg: 'academics', label: 'Academics', short: 'Classes', icon: '📚', perm: 'classes:read' },
    { seg: 'attendance', label: 'Attendance', short: 'Attend.', icon: '✅', perm: 'attendance:read' },
    { seg: 'results', label: 'Exams & Results', short: 'Results', icon: '📝', perm: 'results:read' },
    { seg: 'fees', label: 'Fees & Finance', short: 'Fees', icon: '💳', perm: 'fees:read' },
    { seg: 'timetable', label: 'Timetable', short: 'Timetable', icon: '🗓️', perm: 'timetable:read' },
    { seg: 'communication', label: 'Communication', short: 'Notices', icon: '📢', perm: 'announcements:read' },
    { seg: 'messages', label: 'Messages', short: 'Chat', icon: '💬', perm: 'messages:use' },
    { seg: 'staff', label: 'Staff & HR', short: 'Staff', icon: '👥', anyPerm: ['staff:read', 'tasks:read'] },
    { seg: 'reports', label: 'Reports & Analytics', short: 'Reports', icon: '📈', perm: 'reports:read' },
    { seg: 'settings', label: 'Settings', short: 'Settings', icon: '⚙️', perm: 'settings:read' },
  ];
  const PARENT_NAV = [
    { seg: 'children', label: 'My Children', short: 'Children', icon: '👨‍👧' },
    { seg: 'feed', label: 'Announcements', short: 'Notices', icon: '📢' },
    { seg: 'messages', label: 'Messages', short: 'Chat', icon: '💬' },
  ];
  const SOON = [['📚', 'Library'], ['🚌', 'Transport'], ['📦', 'Inventory']];

  const can = (perm) => SF.me.permissions.includes(perm);
  SF.can = can;
  const isParent = () => SF.me.user.role === 'parent';
  const allowed = (n) => (n.perm ? can(n.perm) : n.anyPerm ? n.anyPerm.some(can) : true);
  const navItems = () => (isParent() ? PARENT_NAV : STAFF_NAV.filter(allowed));
  const $ = (id) => document.getElementById(id);

  function applyBrand() {
    const s = SF.me.school;
    const root = document.documentElement.style;
    if (s.primary_color) root.setProperty('--primary', s.primary_color);
    if (s.secondary_color) root.setProperty('--accent', s.secondary_color);
    $('sideSchool').textContent = s.name;
    $('sideSchool').title = s.name;
    const mark = document.querySelector('.side-brand .brand-mark');
    if (s.logo) {
      mark.textContent = '';
      Object.assign(mark.style, { backgroundImage: `url("${s.logo}")`, backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center', backgroundColor: '#fff' });
    } else mark.textContent = SF.ui.initials(s.name, 'SF');
    try { localStorage.setItem('schoolflow:slug', s.slug); } catch { /* storage blocked */ }
    document.title = `${s.name} · SchoolFlow`;
  }

  const labelOf = (n) => (n.seg === 'staff' && !can('staff:read') ? 'My tasks' : n.label);

  function buildNav() {
    const nav = $('nav');
    mount(nav, html`${navItems().map((n) => html`<a href="#/${n.seg}" data-seg="${n.seg}" title="${labelOf(n)}"><span class="ico" aria-hidden="true">${n.icon}</span><span class="lbl">${labelOf(n)}</span><span class="nav-badge" data-badge="${n.seg}"></span></a>`)}
      ${isParent() ? '' : html`<div class="nav-soon">Coming soon</div>${SOON.map(([ico, label]) => html`<a href="#/" data-soon="${label}" class="soon" title="${label}"><span class="ico" aria-hidden="true">${ico}</span><span class="lbl">${label}</span></a>`)}`}`);
    nav.querySelectorAll('[data-soon]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); toast(`${a.dataset.soon} is on the roadmap`); }));
    nav.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('a[data-seg]')) closeDrawer(); });
  }

  // Phone layout: bottom tab bar (first four sections + More, which opens the full menu)
  function buildTabbar() {
    const items = navItems();
    const main = items.length <= 5 ? items : items.slice(0, 4);
    mount($('tabbar'), html`${main.map((n) => html`<a href="#/${n.seg}" data-seg="${n.seg}" aria-label="${labelOf(n)}"><span class="ico" aria-hidden="true">${n.icon}</span><span class="lbl">${n.short || n.label}</span></a>`)}
      ${items.length > 5 ? html`<button type="button" id="moreBtn" aria-label="More sections"><span class="ico" aria-hidden="true">☰</span><span class="lbl">More</span></button>` : ''}`);
    const more = $('tabbar').querySelector('#moreBtn');
    if (more) more.addEventListener('click', openDrawer);
  }

  const openDrawer = () => { document.body.classList.add('nav-open'); $('menuBtn').setAttribute('aria-expanded', 'true'); };
  const closeDrawer = () => { document.body.classList.remove('nav-open'); $('menuBtn').setAttribute('aria-expanded', 'false'); };

  async function refreshBadges() {
    if (!can('messages:use')) return;
    try {
      const { unread } = await api('GET', '/api/messages/unread');
      const b = document.querySelector('[data-badge="messages"]');
      if (b) b.textContent = unread ? ` (${unread})` : '';
    } catch { /* not critical */ }
  }
  SF.refreshBadges = refreshBadges;

  function setHeader(title, sub) {
    $('pageTitle').textContent = title;
    $('pageSub').textContent = sub || '';
  }

  let navToken = 0;
  // silent = re-render the current page after a save, without the skeleton or the entrance animation
  async function route(silent = false) {
    const token = ++navToken;
    const [pathPart, queryPart = ''] = location.hash.replace(/^#\/?/, '').split('?');
    const args = pathPart.split('/').filter(Boolean);
    const items = navItems();
    const seg = args.shift() || items[0].seg;
    const item = items.find((n) => n.seg === seg);
    if (!item || !SF.views[seg]) { location.hash = `#/${items[0].seg}`; return; }
    document.querySelectorAll('#nav a[data-seg], #tabbar a[data-seg]').forEach((a) => a.classList.toggle('active', a.dataset.seg === seg));
    const el = $('view');
    if (silent === true) el.classList.add('no-anim');
    else { el.classList.remove('no-anim'); mount(el, skeleton()); window.scrollTo({ top: 0 }); closeDrawer(); }
    const view = SF.views[seg];
    setHeader(view.title || item.label, SF.me.school.name);
    try {
      await view.render(el, args, { setHeader: (t, s) => { if (token === navToken) setHeader(t, s === undefined ? SF.me.school.name : s); }, query: new URLSearchParams(queryPart), isCurrent: () => token === navToken });
    } catch (e) {
      if (token !== navToken) return;
      if (e.status === 401) { location.replace('login.html'); return; }
      mount(el, html`<section class="panel"><div class="empty">${e.message || 'Something went wrong.'}<br><br><button class="btn btn-secondary" id="retry">Try again</button></div></section>`);
      el.querySelector('#retry').addEventListener('click', () => route());
    }
    refreshBadges();
  }
  SF.reload = () => route(true);
  SF.reloadMe = async () => { SF.me = await api('GET', '/api/me'); applyBrand(); await route(true); };

  function accountModal() {
    const u = SF.me.user;
    const m = modal({ title: 'Your account', content: html`<div class="kv" style="margin:8px 0 16px"><div><small>Name</small><b>${u.name}</b></div><div><small>Email</small><b>${u.email}</b></div><div><small>Role</small><b>${SF.ui.cap(u.role)}</b></div></div>
      <div class="form-actions"><button class="btn btn-secondary" data-pw>Change password</button><button class="btn btn-primary" data-out>Sign out</button></div>` });
    m.body.querySelector('[data-pw]').addEventListener('click', () => { m.close(); passwordModal(false); });
    m.body.querySelector('[data-out]').addEventListener('click', signOut);
  }

  function passwordModal(forced) {
    formModal({
      title: forced ? 'Choose a new password' : 'Change password', locked: forced, submitLabel: 'Update password',
      fields: [
        ...(forced ? [{ heading: 'You are using a temporary password. Set your own to continue.' }] : []),
        { name: 'current_password', label: forced ? 'Temporary password' : 'Current password', type: 'password', required: true, full: true, autocomplete: 'current-password' },
        { name: 'new_password', label: 'New password', type: 'password', required: true, full: true, autocomplete: 'new-password', help: 'At least 8 characters.' },
        { name: 'confirm', label: 'Confirm new password', type: 'password', required: true, full: true, autocomplete: 'new-password' },
      ],
      onSubmit: async (d) => {
        if (d.new_password !== d.confirm) throw new Error('The new passwords do not match');
        await api('POST', '/api/auth/change-password', { current_password: d.current_password, new_password: d.new_password });
        SF.me.user.must_change_password = false;
        toast('Password updated');
      },
    });
  }

  async function signOut() {
    try { await api('POST', '/api/auth/logout', {}); } catch { /* leave anyway */ }
    SF.store.clear();
    location.href = 'login.html';
  }

  async function boot() {
    try { SF.me = await api('GET', '/api/me'); }
    catch (e) {
      if (e.status === 401) { location.replace('login.html'); return; }
      mount($('view'), html`<div class="empty">${e.message}</div>`);
      return;
    }
    // UI state (filters, selected class…) belongs to one person: drop it if someone else signs in on this tab
    try {
      if (sessionStorage.getItem('sf:ui:user') !== String(SF.me.user.id)) { SF.store.clear(); sessionStorage.setItem('sf:ui:user', String(SF.me.user.id)); }
    } catch { /* storage blocked */ }
    applyBrand();
    buildNav();
    buildTabbar();
    $('menuBtn').addEventListener('click', openDrawer);
    $('scrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
    const pill = $('userPill');
    pill.textContent = SF.ui.initials(SF.me.user.name, '👤');
    pill.title = SF.me.user.name;
    pill.addEventListener('click', accountModal);
    $('logout').addEventListener('click', signOut);
    window.addEventListener('hashchange', () => route());
    await route();
    if (SF.me.user.must_change_password) passwordModal(true);
  }

  if (document.getElementById('nav')) boot();
})();
