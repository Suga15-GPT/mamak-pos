import { state, $ } from './state.js';
import { renderTables } from './pos.js';
import { refreshKitchen } from './kitchen.js';
import { refreshDashboard } from './dashboard.js';
import { refreshAdmin } from './admin.js';
import { refreshShift } from './shift.js';

/* ===== NAV ===== */
export function buildNav() {
  const tabs = [
    { id: 'pos', label: 'Orders', roles: ['admin', 'staff'] },
    { id: 'kitchen', label: 'Kitchen', roles: ['admin', 'staff', 'kitchen'] },
    { id: 'dashboard', label: 'Dashboard', roles: ['admin', 'staff'] },
    { id: 'shift', label: 'Shift', roles: ['admin', 'staff'] },
    { id: 'admin', label: 'Admin', roles: ['admin'] },
  ];
  const allowed = tabs.filter(t => t.roles.includes(API.user.role));
  $('nav').innerHTML = allowed.map((t, i) =>
    `<button class="${i === 0 ? 'active' : ''}" data-action="switch-tab" data-id="${t.id}">${t.label}</button>`
  ).join('');
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  $('tab-' + allowed[0].id).classList.add('active');
}

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
