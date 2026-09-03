// api.js — talks to the backend
const API = {
  token: localStorage.getItem('pos_token') || null,
  user: JSON.parse(localStorage.getItem('pos_user') || 'null'),

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
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
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },

  async login(name, pin) {
    const data = await this.request('POST', '/api/login', { name, pin });
    this.token = data.token;
    this.user = { name: data.name, role: data.role };
    localStorage.setItem('pos_token', data.token);
    localStorage.setItem('pos_user', JSON.stringify(this.user));
    return data;
  },

  async logout() {
    const token = this.token;
    this.token = null;
    this.user = null;
    localStorage.removeItem('pos_token');
    localStorage.removeItem('pos_user');
    if (token) {
      try { await fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); }
      catch (e) { /* best effort */ }
    }
  },

  get(p)   { return this.request('GET', p); },
  post(p, b)  { return this.request('POST', p, b); },
  patch(p, b) { return this.request('PATCH', p, b); },
  del(p)   { return this.request('DELETE', p); },

  /* fetch an authenticated binary resource (e.g. QR PNGs) as an object URL */
  async getBlobUrl(path) {
    const headers = {};
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    const res = await fetch(path, { headers });
    if (!res.ok) throw new Error('failed to load ' + path);
    return URL.createObjectURL(await res.blob());
  },
};