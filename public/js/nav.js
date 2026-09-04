import { state, $ } from './state.js';
import { refreshPos } from './pos.js';
import { refreshKitchen } from './kitchen.js';
import { refreshDashboard } from './dashboard.js';
import { refreshAdmin } from './admin.js';
import { refreshShift } from './shift.js';
import { t } from './i18n.js';

/* Navigation is simplified by role (master spec §40): a cook sees the kitchen
   and nothing else; a waiter sees the floor. Every destination carries an icon
   AND a word — an icon alone is a guess, and this room has staff who read
   English slowly. Nothing frequently used is hidden behind a hamburger. */
const TAB_DEFS = [
  { id: 'pos',       key: 'nav.pos',       icon: '🍽', roles: ['admin', 'staff'] },
  { id: 'kitchen',   key: 'nav.kitchen',   icon: '🍳', roles: ['admin', 'staff', 'kitchen'] },
  { id: 'dashboard', key: 'nav.dashboard', icon: '💰', roles: ['admin', 'staff'] },
  { id: 'shift',     key: 'nav.shift',     icon: '🕐', roles: ['admin', 'staff'] },
  { id: 'admin',     key: 'nav.admin',     icon: '⚙',  roles: ['admin'] },
];

let activeTab = null;
// Rounds waiting for staff approval — surfaced as a count on the Kitchen tab so
// nobody has to go looking for a queue that is usually empty.
let pendingCount = 0;

function allowed() { return TAB_DEFS.filter(def => def.roles.includes(API.user.role)); }

function buttonHtml(def) {
  const badge = def.id === 'kitchen' && pendingCount ? `<span class="nav-badge">${pendingCount}</span>` : '';
  return `<button class="${def.id === activeTab ? 'active' : ''}" data-action="switch-tab" data-id="${def.id}"
            aria-current="${def.id === activeTab ? 'page' : 'false'}">
            <span class="nav-ico" aria-hidden="true">${def.icon}</span><span>${t(def.key)}</span>${badge}</button>`;
}

function paint() {
  const html = allowed().map(buttonHtml).join('');
  $('nav').innerHTML = html;
  $('bottom-nav').innerHTML = html;
}

export function buildNav() {
  const first = allowed()[0]?.id;
  activeTab = null;
  // Go through switchTab so the first tab actually loads its data. Marking it
  // active without that left a cook staring at an empty kitchen until the 60s
  // backstop poll happened to fire.
  if (first) switchTab(first);
  else paint();
}

export function setPendingCount(n) {
  if (n === pendingCount) return;
  pendingCount = n;
  paint();
}

document.addEventListener('localechange', paint);

export function switchTab(id) {
  if (!allowed().some(d => d.id === id)) return;
  activeTab = id;
  paint();
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  $('tab-' + id).classList.add('active');
  window.scrollTo({ top: 0 });
  if (id === 'pos') refreshPos();
  if (id === 'kitchen') refreshKitchen();
  if (id === 'dashboard') refreshDashboard();
  if (id === 'shift') refreshShift();
  if (id === 'admin') refreshAdmin();
}

/* ===== LIVE REFRESH ===== */
export function refreshLive() {
  if (activeTab === 'kitchen') refreshKitchen();
  if (activeTab === 'dashboard') refreshDashboard();
  if (activeTab === 'pos') refreshPos();
}

export const currentTab = () => activeTab;

[$('nav'), $('bottom-nav')].forEach(el => el.addEventListener('click', e => {
  const btn = e.target.closest('[data-action="switch-tab"]');
  if (btn) switchTab(btn.dataset.id);
}));
