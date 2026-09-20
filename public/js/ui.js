/* SchoolFlow — UI helpers. Everything rendered through html`` is escaped automatically. */
(function () {
  const SF = window.SF;

  /* ---------- safe templating ---------- */
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  class Raw { constructor(s) { this.s = s; } }
  const raw = (s) => new Raw(String(s));
  const render = (x) => (x === null || x === undefined || x === false ? '' : Array.isArray(x) ? x.map(render).join('') : x instanceof Raw ? x.s : esc(x));
  const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? render(vals[i]) : ''), ''));
  const mount = (el, r) => { el.innerHTML = r instanceof Raw ? r.s : esc(r); };

  /* ---------- formatting ---------- */
  const money = (p) => 'GH₵ ' + (Number(p || 0) / 100).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // "1250.50" -> 125050 pesewas, or null when invalid
  const parseMoney = (str) => {
    const s = String(str || '').replace(/[,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    return Math.round(parseFloat(s) * 100);
  };
  const dateOnly = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s));
  const fmtDate = (s) => (s ? dateOnly(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const fmtDateTime = (s) => (s ? new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const ago = (s) => {
    const m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    if (m < 1440) return `${Math.round(m / 60)} hr ago`;
    return fmtDate(s);
  };
  const ordinal = (n) => {
    if (n === null || n === undefined) return '—';
    const v = n % 100;
    return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th');
  };
  const initials = (name, fallback = '?') => {
    const w = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!w.length) return fallback;
    return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[w.length - 1][0]).toUpperCase();
  };
  const todayStr = () => new Date().toLocaleDateString('en-CA');
  const pct = (x) => (x === null || x === undefined ? '—' : `${x}%`);
  const age = (dob) => {
    if (!dob) return null;
    const d = new Date(dob + 'T00:00:00'); const n = new Date();
    let a = n.getFullYear() - d.getFullYear();
    if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--;
    return a;
  };
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
  const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /* ---------- small components ---------- */
  const badge = (text, kind = '') => html`<span class="badge ${kind}">${text}</span>`;
  const STATUS_KIND = { active: 'green', applicant: 'blue', graduated: 'amber', transferred: '', withdrawn: 'red' };
  const statusBadge = (s) => badge(cap(s), STATUS_KIND[s] || '');
  const bar = (p) => html`<div class="bar"><i style="width:${Math.max(0, Math.min(100, p || 0))}%"></i></div>`;

  function table(cols, rows, { empty = 'Nothing here yet.', rowAttr } = {}) {
    if (!rows.length) return html`<div class="empty">${empty}</div>`;
    return html`<div class="table-wrap"><table><thead><tr>${cols.map((c) => html`<th class="${c.cls || ''}">${c.label}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr ${rowAttr ? raw(rowAttr(r)) : ''}>${cols.map((c) => html`<td class="${c.cls || ''}" data-label="${c.label}"><div class="cell">${c.render ? c.render(r) : r[c.key]}</div></td>`)}</tr>`)}</tbody></table></div>`;
  }

  const pager = ({ page, limit, total }) => {
    const pages = Math.max(1, Math.ceil(total / limit));
    if (pages <= 1) return html`<div class="pager"><span>${total} ${total === 1 ? 'record' : 'records'}</span></div>`;
    return html`<div class="pager"><span>${total} records</span><div>
      <button class="btn btn-secondary btn-sm" data-page="${page - 1}" ${page <= 1 ? raw('disabled') : ''}>Previous</button>
      <span>Page ${page} of ${pages}</span>
      <button class="btn btn-secondary btn-sm" data-page="${page + 1}" ${page >= pages ? raw('disabled') : ''}>Next</button></div></div>`;
  };
  const bindPager = (el, cb) => el.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => cb(Number(b.dataset.page))));

  /* ---------- feedback ---------- */
  function toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    t.textContent = `${kind === 'error' ? '⚠' : '✓'}  ${msg}`;
    document.body.appendChild(t);
    setTimeout(() => { t.className = `toast ${kind} out`; setTimeout(() => t.remove(), 220); }, kind === 'error' ? 5000 : 2600);
  }
  // Disable a button and show a spinner while an async action runs
  async function busy(btn, fn) {
    btn.disabled = true; btn.classList.add('loading');
    try { return await fn(); } finally { btn.disabled = false; btn.classList.remove('loading'); }
  }
  const skeleton = () => html`<div class="skel-wrap" aria-hidden="true"><div class="skel-row"><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div><div class="skel skel-lg"></div><div class="skel skel-lg"></div></div>`;
  const fail = (e) => toast((e && e.message) || 'Something went wrong', 'error');

  function modal({ title, content, wide = false, locked = false }) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><h2>${esc(title)}</h2>${locked ? '' : '<button type="button" class="modal-x" aria-label="Close">×</button>'}</header><div class="modal-body"></div></div>`;
    const body = back.querySelector('.modal-body');
    if (content) mount(body, content);
    document.body.appendChild(back);
    const onKey = (e) => { if (e.key === 'Escape' && !locked) close(); };
    function close() { back.remove(); document.removeEventListener('keydown', onKey); }
    if (!locked) {
      document.addEventListener('keydown', onKey);
      back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
      back.querySelector('.modal-x').addEventListener('click', close);
    }
    return { el: back, body, close };
  }

  function confirmBox({ title = 'Are you sure?', message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const m = modal({ title, content: html`<p>${message}</p><div class="form-actions"><button class="btn btn-secondary" data-no>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${confirmLabel}</button></div>` });
      m.body.querySelector('[data-no]').addEventListener('click', () => { m.close(); resolve(false); });
      m.body.querySelector('[data-yes]').addEventListener('click', () => { m.close(); resolve(true); });
    });
  }

  /* ---------- generated forms ---------- */
  function control(f, values) {
    const val = values[f.name] ?? f.default ?? '';
    const req = f.required ? raw(' required') : '';
    if (f.type === 'select') {
      return html`<select name="${f.name}" ${req}>${f.placeholder !== undefined ? html`<option value="">${f.placeholder}</option>` : ''}
        ${(f.options || []).map((o) => html`<option value="${o.value}" ${String(o.value) === String(val) ? raw('selected') : ''}>${o.label}</option>`)}</select>`;
    }
    if (f.type === 'textarea') return html`<textarea name="${f.name}" rows="${f.rows || 3}" maxlength="${f.max || 1000}" ${req}>${val}</textarea>`;
    if (f.type === 'checkbox') return html`<input type="checkbox" name="${f.name}" value="1" ${val ? raw('checked') : ''} style="width:auto">`;
    const extra = ['step', 'min', 'max', 'placeholder', 'autocomplete', 'maxlength'].filter((k) => f[k] !== undefined).map((k) => `${k}="${esc(f[k])}"`).join(' ');
    return html`<input name="${f.name}" type="${f.type || 'text'}" value="${f.type === 'password' ? '' : val}" ${req} ${raw(extra)}>`;
  }

  // fields: [{name,label,type,required,options,full,help}, {heading:'…'}]
  function formModal({ title, fields, values = {}, submitLabel = 'Save', onSubmit, wide = false, locked = false, cancel = true }) {
    const m = modal({ title, wide, locked });
    mount(m.body, html`<form><div class="fgrid">${fields.map((f) => (f.heading
      ? html`<h4>${f.heading}</h4>`
      : html`<label class="${f.full ? 'full' : ''}">${f.label}${f.required ? ' *' : ''}${control(f, values)}${f.help ? html`<span class="help">${f.help}</span>` : ''}</label>`))}</div>
      <div class="form-error" role="alert"></div>
      <div class="form-actions">${cancel && !locked ? html`<button type="button" class="btn btn-secondary" data-cancel>Cancel</button>` : ''}<button type="submit" class="btn btn-primary">${submitLabel}</button></div></form>`);
    const form = m.body.querySelector('form');
    const err = form.querySelector('.form-error');
    const btn = form.querySelector('button[type=submit]');
    const cancelBtn = form.querySelector('[data-cancel]');
    if (cancelBtn) cancelBtn.addEventListener('click', m.close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = ''; btn.disabled = true; btn.classList.add('loading');
      const data = Object.fromEntries(new FormData(form));
      try { await onSubmit(data, m); m.close(); } catch (ex) { err.textContent = ex.message || 'Something went wrong'; btn.disabled = false; btn.classList.remove('loading'); }
    });
    const first = form.querySelector('input:not([type=hidden]),select,textarea');
    if (first) first.focus();
    return m;
  }

  // Show a one-time secret (temporary password) so the admin can hand it over
  function secretModal(title, intro, secret) {
    const m = modal({ title, content: html`<p>${intro}</p><div class="secret">${secret}</div>
      <p class="muted small">This is shown only once. They will be asked to choose a new password when they sign in.</p>
      <div class="form-actions"><button class="btn btn-secondary" data-copy>Copy</button><button class="btn btn-primary" data-done>Done</button></div>` });
    m.body.querySelector('[data-copy]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(secret); toast('Copied'); } catch { toast('Select the text and copy it manually'); }
    });
    m.body.querySelector('[data-done]').addEventListener('click', m.close);
  }

  // Print just the contents of a modal (report cards, receipts)
  function printModal() { document.body.classList.add('printing'); window.print(); setTimeout(() => document.body.classList.remove('printing'), 500); }

  /* ---------- UI state that survives switching tabs (kept for this browser tab only) ---------- */
  const PREFIX = 'sf:ui:';
  SF.store = {
    // const s = SF.store.persist('students', { q: '', page: 1 });  s.q = 'ama' is saved automatically
    persist(ns, defaults) {
      let saved = {};
      try { saved = JSON.parse(sessionStorage.getItem(PREFIX + ns) || '{}') || {}; } catch { saved = {}; }
      const data = { ...defaults, ...saved };
      return new Proxy(data, { set(t, k, v) { t[k] = v; try { sessionStorage.setItem(PREFIX + ns, JSON.stringify(t)); } catch { /* storage full or blocked */ } return true; } });
    },
    clear() {
      try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) { const k = sessionStorage.key(i); if (k && k.startsWith(PREFIX)) sessionStorage.removeItem(k); }
      } catch { /* ignore */ }
    },
  };

  SF.ui = {
    esc, raw, html, mount, money, parseMoney, fmtDate, fmtDateTime, ago, ordinal, initials, todayStr, pct, age, cap, debounce,
    badge, statusBadge, bar, table, pager, bindPager, toast, fail, busy, skeleton, modal, confirmBox, formModal, secretModal, printModal,
  };
})();
