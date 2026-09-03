/* ===== STATE ===== */
export const state = {
  menu: { categories: [], items: [], modifier_groups: [], modifier_options: [] },
  tables: [],
  cart: [],
  selTable: null,
  activeCat: null,
  modItem: null,
  pollTimer: null,
  pendingRemarkItem: null,
};

/* ===== HELPERS ===== */
export const $ = id => document.getElementById(id);
export const fmt = n => 'RM ' + Number(n).toFixed(2);
export function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2500);
}
export function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
