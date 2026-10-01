// version.js — reload a till that is still running the screens from before an
// update (review N2, F3). The server stamps its build into the page it serves
// (index.html, '/'), reports it at /api/version, and names the service
// worker's cache after it. When the server's build differs from the page's
// own, the page waits for a quiet moment (no dialog open, nothing unsent on
// the bill, no expense draft open), fetches the new service worker, waits for
// it to take over — so the reload can't be answered from the old cache — and
// reloads. Queued orders live in the outbox, so they survive a reload.
import { state, $ } from './state.js';

// The build this page belongs to. A page with no stamp is from before stamps
// existed, so it is out of date by definition: it never takes the server's
// build as its own (that is how a stale page used to stop checking for good).
const running = document.querySelector('meta[name="app-version"]')?.content || 'unstamped';
const TRIED_KEY = 'pos_reloaded_for';
let pending = false;
let reloading = false;

async function serverVersion() {
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    return r.ok ? (await r.json()).version : null;
  } catch { return null; }
}

function busy() {
  if (document.querySelector('.modal-bg.show')) return true;
  if ((state.cart || []).some(l => !l.sent)) return true;
  const draft = $('exp-form');
  if (draft && !draft.hidden) return true;
  const active = document.activeElement;
  return !!(active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && active.value);
}

function showBanner(text) {
  const b = $('update-banner');
  if (!b) return;
  if (text) b.textContent = text;
  b.hidden = false;
}

// Resolves once a service worker of the new build controls this page, or
// after `ms` without one.
function newWorkerInControl(reg, ms) {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (!done) { done = true; resolve(ok); } };
    navigator.serviceWorker.addEventListener('controllerchange', () => finish(true), { once: true });
    setTimeout(() => finish(false), ms);
    reg.update().catch(() => {});
  });
}

async function reloadToNewBuild(target) {
  reloading = true;
  // Already reloaded once for this build and still on the old one: don't loop.
  // Say so instead, and let a person close and reopen the POS.
  let tried = null;
  try { tried = sessionStorage.getItem(TRIED_KEY); } catch { /* private mode */ }
  if (tried === target) {
    showBanner('The POS has been updated. Close this tab and open the POS again to finish the update.');
    return;
  }
  const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration().catch(() => null);
  if (reg) await newWorkerInControl(reg, 30000);
  try { sessionStorage.setItem(TRIED_KEY, target); } catch { /* private mode */ }
  location.reload();
}

async function check() {
  if (reloading) return;
  const v = await serverVersion();
  if (!v || v === running) return;
  pending = true;
  if (busy()) { showBanner(); return; }
  reloadToNewBuild(v);
}

export function startVersionCheck() {
  check();
  setInterval(check, 30000);
  // Once an update is known, look for a quiet moment every few seconds.
  setInterval(() => { if (pending) check(); }, 5000);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}
