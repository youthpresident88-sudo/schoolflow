/* SchoolFlow — tiny API client shared by every page */
(function () {
  const SF = (window.SF = window.SF || {});

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) throw new ApiError(res.status, (data && data.error && data.error.message) || `Request failed (${res.status})`);
    return data;
  }

  // ?a=1&b=2 from an object, skipping empty values
  function qs(obj) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  // Resize an uploaded image so it is small enough to store (logo / login background)
  function imageToDataUrl(file, maxDim, mime, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return reject(new Error('That image has no size. Try a PNG or JPEG.'));
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.round(w * scale); c.height = Math.round(h * scale);
        const ctx = c.getContext('2d');
        if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL(mime, quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
      img.src = url;
    });
  }

  SF.ApiError = ApiError;
  SF.api = api;
  SF.qs = qs;
  SF.imageToDataUrl = imageToDataUrl;
  SF.views = SF.views || {};
})();
