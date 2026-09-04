// api.js — talks to the backend.
// Phase 11: the session itself lives in an httpOnly cookie (set by the
// server, invisible to this script and to any injected one) instead of a
// bearer token in localStorage. Only the CSRF token — useless to an
// attacker without also being able to ride the cookie, which is exactly
// what httpOnly prevents — and the display-only user info are kept here.
const API = {
  csrfToken: localStorage.getItem('pos_csrf') || null,
  user: JSON.parse(localStorage.getItem('pos_user') || 'null'),

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.csrfToken && method !== 'GET') headers['X-CSRF-Token'] = this.csrfToken;
    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      this.logout();
      showLogin();
      throw new Error('Session expired. Please log in again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, body: data });
    return data;
  },

  async login(name, pin) {
    const data = await this.request('POST', '/api/login', { name, pin });
    this.csrfToken = data.csrf_token;
    this.user = { name: data.name, role: data.role, must_change_pin: !!data.must_change_pin };
    localStorage.setItem('pos_csrf', data.csrf_token);
    localStorage.setItem('pos_user', JSON.stringify(this.user));
    return data;
  },

  async logout() {
    this.csrfToken = null;
    this.user = null;
    localStorage.removeItem('pos_csrf');
    localStorage.removeItem('pos_user');
    try { await fetch('/api/logout', { method: 'POST' }); }
    catch (e) { /* best effort */ }
  },

  get(p)   { return this.request('GET', p); },
  post(p, b)  { return this.request('POST', p, b); },
  patch(p, b) { return this.request('PATCH', p, b); },
  del(p)   { return this.request('DELETE', p); },

  /* fetch an authenticated binary resource (e.g. QR PNGs) as an object URL —
     the session cookie rides along with this fetch automatically now, no
     header to attach by hand. */
  async getBlobUrl(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error('failed to load ' + path);
    return URL.createObjectURL(await res.blob());
  },
};
