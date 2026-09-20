/* SchoolFlow — onboarding wizard and sign-in (talks to the real API) */
(() => {
  'use strict';
  const SF = window.SF;
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const HEX = /^#[0-9a-f]{6}$/i;

  const initials = (name, fallback) => {
    const w = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!w.length) return fallback;
    return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[w.length - 1][0]).toUpperCase();
  };
  const applyColors = (p, s) => {
    if (HEX.test(p)) root.style.setProperty('--primary', p);
    if (HEX.test(s)) root.style.setProperty('--accent', s);
  };
  function setLogo(el, dataUrl, fallback) {
    if (!el) return;
    if (dataUrl) {
      el.textContent = '';
      Object.assign(el.style, { backgroundImage: `url("${dataUrl}")`, backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center', backgroundColor: '#fff' });
    } else { el.textContent = fallback; el.style.backgroundImage = ''; el.style.backgroundColor = ''; }
  }

  /* ---------------- onboarding ---------------- */
  const TOTAL = 5;
  let current = 1;
  const images = { logo: null, cover: null };
  const pending = {};

  function showStep(n, scroll = true) {
    current = n;
    document.querySelectorAll('.step-panel').forEach((p) => p.classList.toggle('active', Number(p.dataset.step) === n));
    document.querySelectorAll('.steps span').forEach((s, i) => s.classList.toggle('active', i + 1 <= n));
    if (n === TOTAL) buildSummary();
    refreshPreview();
    if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function nextStep() {
    if (current === 1) {
      const p = $('phone');
      p.setCustomValidity(/^(\+?233|0)\d{9}$/.test(p.value.replace(/[\s-]/g, '')) ? '' : 'Enter a valid Ghana number, e.g. 024 000 0000');
    }
    const panel = document.querySelector(`.step-panel[data-step="${current}"]`);
    for (const field of panel.querySelectorAll('input, select')) {
      if (!field.checkValidity()) { field.reportValidity(); return; }
    }
    if (current < TOTAL) showStep(current + 1);
  }
  const prevStep = () => { if (current > 1) showStep(current - 1); };

  function refreshPreview() {
    if (!$('liveName')) return;
    const name = $('schoolName').value.trim();
    $('liveName').textContent = name || 'Your School';
    $('liveMotto').textContent = $('motto').value.trim() || 'Your motto';
    applyColors($('primary').value, $('secondary').value);
    setLogo($('liveLogo'), images.logo, initials(name, 'GS'));
  }

  function collect() {
    const v = (id) => $(id).value.trim();
    return {
      admin: { name: v('adminName'), email: v('schoolEmail'), phone: v('phone'), password: $('password').value },
      school: {
        name: v('schoolName'), type: $('schoolType').value, location: v('location'), motto: v('motto'),
        expected_students: parseInt($('studentCount').value, 10) || undefined,
        primary: $('primary').value, secondary: $('secondary').value, logo: images.logo || undefined, cover: images.cover || undefined,
        academic_year: v('academicYear'), terms: v('terms'), levels: v('levels'), ca_max: Number($('caMax').value),
      },
    };
  }

  function buildSummary() {
    const { admin, school } = collect();
    const rows = [['School', school.name], ['Type', school.type], ['Location', school.location], ['Administrator', admin.name], ['Sign-in email', admin.email],
      ['Academic year', school.academic_year], ['Terms', school.terms], ['Classes', school.levels], ['Assessment', `${school.ca_max} class score + ${100 - school.ca_max} exam`]];
    $('summary').replaceChildren(...rows.map(([label, value]) => {
      const row = document.createElement('div'); const s = document.createElement('span'); const b = document.createElement('b');
      s.textContent = label; b.textContent = value || '—'; row.append(s, b); return row;
    }));
    $('finishTitle').textContent = school.name ? `${school.name} is ready.` : 'Your school is ready.';
  }

  function handleImage(input, key, maxDim, mime, quality) {
    const file = input.files && input.files[0];
    if (!file) { images[key] = null; pending[key] = null; refreshPreview(); return; }
    pending[key] = SF.imageToDataUrl(file, maxDim, mime, quality)
      .then((url) => { images[key] = url; refreshPreview(); })
      .catch((err) => { input.value = ''; images[key] = null; refreshPreview(); $('onboardError').textContent = err.message; });
  }

  async function completeOnboarding(e) {
    e.preventDefault();
    if (current < TOTAL) { nextStep(); return; } // Enter key pressed on an earlier step
    const btn = $('launch'); const err = $('onboardError');
    err.textContent = ''; btn.disabled = true; btn.textContent = 'Creating your school…';
    try {
      await Promise.all(Object.values(pending));
      await SF.api('POST', '/api/schools', collect());
      location.href = 'dashboard.html';
    } catch (ex) {
      err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Launch school dashboard';
      if (/email/i.test(ex.message)) showStep(1);
    }
  }

  function initOnboarding() {
    ['schoolName', 'motto', 'primary', 'secondary'].forEach((id) => $(id).addEventListener('input', refreshPreview));
    $('phone').addEventListener('input', (e) => e.target.setCustomValidity(''));
    $('logo').addEventListener('change', (e) => handleImage(e.target, 'logo', 256, 'image/png'));
    $('cover').addEventListener('change', (e) => handleImage(e.target, 'cover', 1600, 'image/jpeg', 0.82));
    showStep(1, false);
  }

  /* ---------------- sign in ---------------- */
  async function login(e) {
    e.preventDefault();
    const err = $('loginError'); const btn = $('loginBtn');
    err.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      await SF.api('POST', '/api/auth/login', { email: $('email').value.trim(), password: $('password').value });
      location.href = 'dashboard.html';
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Sign in'; }
  }

  // Show the school's own logo, name and colours if we know which school this is
  async function brandLogin() {
    let slug = new URLSearchParams(location.search).get('school');
    if (!slug) { try { slug = localStorage.getItem('schoolflow:slug'); } catch { slug = null; } }
    try {
      const s = await SF.api('GET', `/api/public/school${SF.qs({ school: slug })}`);
      applyColors(s.primary_color, s.secondary_color);
      document.title = `Sign in — ${s.name}`;
      const brand = document.querySelector('.auth-brand');
      const mark = brand.querySelector('.brand-mark'); const h1 = brand.querySelector('h1'); const p = brand.querySelector('p');
      Object.assign(brand.style, { flexDirection: 'column', textAlign: 'center', gap: '8px' });
      Object.assign(mark.style, { width: '64px', height: '64px', fontSize: '20px', borderRadius: '18px' });
      setLogo(mark, s.logo, initials(s.name, 'SF'));
      h1.textContent = s.name; Object.assign(h1.style, { fontSize: 'clamp(24px,6vw,32px)', margin: '0' });
      p.textContent = s.motto || 'School portal'; Object.assign(p.style, { position: 'static', margin: '0' });
      if (s.cover) Object.assign(document.body.style, { backgroundImage: `linear-gradient(rgba(248,250,252,.82),rgba(248,250,252,.82)),url("${s.cover}")`, backgroundSize: 'cover', backgroundPosition: 'center' });
      if (s.admissions_open) { $('applyLink').style.display = ''; $('applyA').href = `apply.html?school=${encodeURIComponent(s.slug)}`; }
    } catch { /* unknown school: keep the generic SchoolFlow look */ }
  }

  window.nextStep = nextStep;
  window.prevStep = prevStep;
  window.completeOnboarding = completeOnboarding;
  window.login = login;

  const cls = document.body.classList;
  if (cls.contains('onboard-page')) initOnboarding();
  else if (cls.contains('auth-page')) brandLogin();
})();
