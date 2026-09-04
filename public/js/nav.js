import { state, $ } from './state.js';
import { renderTables } from './pos.js';
import { refreshKitchen } from './kitchen.js';
import { refreshDashboard } from './dashboard.js';
import { refreshAdmin } from './admin.js';
import { refreshShift } from './shift.js';
import { t } from './i18n.js';

const TAB_DEFS = [
  { id: 'pos', key: 'nav.pos', roles: ['admin', 'staff'] },
  { id: 'kitchen', key: 'nav.kitchen', roles: ['admin', 'staff', 'kitchen'] },
  { id: 'dashboard', key: 'nav.dashboard', roles: ['admin', 'staff'] },
  { id: 'shift', key: 'nav.shift', roles: ['admin', 'staff'] },
  { id: 'admin', key: 'nav.admin', roles: ['admin'] },
];

/* ===== NAV ===== */
export function buildNav() {
  const allowed = TAB_DEFS.filter(def => def.roles.includes(API.user.role));
  $('nav').innerHTML = allowed.map((def, i) =>
    `<button class="${i === 0 ? 'active' : ''}" data-action="switch-tab" data-id="${def.id}">${t(def.key)}</button>`
  ).join('');
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  $('tab-' + allowed[0].id).classList.add('active');
}

// Re-labels the already-built nav in place — used when the locale toggles
// mid-session, so it doesn't also reset whichever tab is currently active
// the way a full buildNav() would.
function refreshNavLabels() {
  document.querySelectorAll('#nav button[data-id]').forEach(btn => {
    const def = TAB_DEFS.find(d => d.id === btn.dataset.id);
    if (def) btn.textContent = t(def.key);
  });
}
document.addEventListener('localechange', refreshNavLabels);

function switchTab(id, btn) {
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  $('tab-' + id).classList.add('active');
  if (id === 'kitchen') refreshKitchen();
  if (id === 'dashboard') refreshDashboard();
  if (id === 'shift') refreshShift();
  if (id === 'admin') refreshAdmin();
}

/* ===== LIVE REFRESH ===== */
export function refreshLive() {
  const active = (document.querySelector('.tab.active')?.id || '').replace(/^tab-/, '');
  if (active === 'kitchen') refreshKitchen();
  if (active === 'dashboard') refreshDashboard();
  if (active === 'pos' && !state.selTable) renderTables();
}

$('nav').addEventListener('click', e => {
  const el = e.target.closest('[data-action="switch-tab"]');
  if (!el) return;
  switchTab(el.dataset.id, el);
});
