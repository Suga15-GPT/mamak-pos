import { state, $, connectStream, disconnectStream } from './state.js';
import { loadAll } from './pos.js';
import { buildNav, refreshLive } from './nav.js';
import { startOutbox } from './outbox.js';
import { openChangePinDialog } from './staff.js';
import './i18n.js';

/* ===== OFFLINE (phase 07) =====
   Started unconditionally at page load — not gated behind login — so a reload
   while offline still flushes whatever the outbox is still holding once the
   network (and, separately, a session) comes back. */
startOutbox();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

/* ===== THEME ===== */
function toggleTheme() {
  document.body.classList.toggle('dark');
  localStorage.setItem('pos_theme', document.body.classList.contains('dark') ? 'dark' : 'light');
}
if (localStorage.getItem('pos_theme') === 'dark') document.body.classList.add('dark');

/* ===== AUTH ===== */
async function doLogin() {
  $('lerr').textContent = '';
  try {
    await API.login($('lname').value.trim(), $('lpin').value.trim());
    showApp();
  } catch (e) { $('lerr').textContent = e.message; }
}
async function doLogout() { await API.logout(); showLogin(); }
function showLogin() {
  $('login-view').style.display = ''; $('app-view').style.display = 'none';
  if (state.pollTimer) clearInterval(state.pollTimer);
  disconnectStream();
}
function loadApp() {
  buildNav();
  loadAll();
  connectStream();
  // The stream (via onStreamEvent in kitchen.js/pos.js) is the live path now; this
  // is just the 60s belt-and-braces backstop for a wedged proxy.
  state.pollTimer = setInterval(refreshLive, 60000);
}

function showApp() {
  $('login-view').style.display = 'none';
  $('app-view').style.display = '';
  $('uname').textContent = API.user.name + ' (' + API.user.role + ')';
  // must_change_pin blocks every other endpoint server-side (lib/auth.js) —
  // loading menu/tables/the stream now would just be a wall of 403s behind
  // a dialog that can't be dismissed anyway. staff.js's pin-changed event
  // (fired once the mandatory change succeeds) picks up loadApp() from here.
  if (API.user.must_change_pin) { openChangePinDialog(true); return; }
  loadApp();
}
document.addEventListener('pin-changed-mandatory', loadApp);

/* api.js calls this directly (as a plain global) when a session expires */
window.showLogin = showLogin;

/* ===== EVENT WIRING ===== */
$('login-view').addEventListener('click', e => {
  if (e.target.closest('[data-action="login"]')) doLogin();
});
document.querySelector('header').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'toggle-theme') toggleTheme();
  else if (el.dataset.action === 'logout') doLogout();
  else if (el.dataset.action === 'change-pin') openChangePinDialog(false);
});

/* ===== INIT =====
   Phase 11: the session itself is an httpOnly cookie this script can't read
   — API.user (cached at login) is the optimistic signal; if the cookie has
   actually expired, the first API call 401s and api.js's own handler routes
   back to the login screen. */
if (API.user) showApp(); else showLogin();
