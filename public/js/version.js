// version.js — reload a till that is still running the screens from before an
// update (review N2). The server reports a hash of the files it serves, stamps
// it into index.html, and names the service worker's cache after it. Once the
// server's differs from the page's own, the page fetches the new service
// worker, waits for it to take over (so the reload isn't served the old files
// from cache), and reloads at the first moment nobody is mid-task: no dialog
// open and nothing unsent on the bill being built. Queued orders live in the outbox, so they
// survive a reload.
import { state, $ } from './state.js';

let running = null;   // the build this page is running
let pending = false;
let reloading = false;

async function serverVersion() {
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    return r.ok ? (await r.json()).version : null;
  } catch { return null; }
}

// The build this page belongs to, stamped into index.html by the server.
async function runningVersion() {
  return document.querySelector('meta[name="app-version"]')?.content || serverVersion();
}

function busy() {
  if (document.querySelector('.modal-bg.show')) return true;
  if ((state.cart || []).some(l => !l.sent)) return true;
  const active = document.activeElement;
  return !!(active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && active.value);
}

async function reloadOnNewWorker() {
  reloading = true;
  const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => null);
  if (reg) {
    const takenOver = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    await reg.update().catch(() => {});
    await Promise.race([takenOver, new Promise(r => setTimeout(r, 8000))]);
  }
  location.reload();
}

async function check() {
  if (reloading) return;
  if (!running) { running = await runningVersion(); return; }
  const v = await serverVersion();
  if (!v || v === running) return;
  pending = true;
  if (busy()) { const b = $('update-banner'); if (b) b.hidden = false; return; }
  reloadOnNewWorker();
}

export function startVersionCheck() {
  check();
  setInterval(check, 30000);
  // Once an update is known, look for a quiet moment every few seconds.
  setInterval(() => { if (pending) check(); }, 5000);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}
