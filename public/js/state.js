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

/* ===== REALTIME (phase 06) =====
   One EventSource for the whole app; tabs subscribe via onStreamEvent and decide
   for themselves whether to refetch (they know which tab is active).
   (Phase 11) EventSource can't set an Authorization header, but it sends
   cookies automatically on a same-origin connection — now that sessions are
   an httpOnly cookie instead of a bearer token, there's nothing left to pass
   in the URL at all. */
let es = null;
let reconnectDelay = 1000;
let reconnectTimer = null;
let debounceTimer = null;
let pendingEvents = [];
let lastSeq = 0;
const streamListeners = new Set();

export function onStreamEvent(fn) { streamListeners.add(fn); return () => streamListeners.delete(fn); }

function setConnDot(status) {
  const dot = $('conn-dot');
  if (!dot) return;
  dot.classList.remove('connected', 'reconnecting', 'offline');
  dot.classList.add(status);
}

function dispatchStream(event) {
  pendingEvents.push(event);
  clearTimeout(debounceTimer);
  // A 12-line order fires several events in a row — debounce so that doesn't
  // trigger a refetch per line.
  debounceTimer = setTimeout(() => {
    const batch = pendingEvents;
    pendingEvents = [];
    streamListeners.forEach(fn => fn(batch));
  }, 250);
}

export function connectStream() {
  clearTimeout(reconnectTimer);
  if (es) { es.close(); es = null; }
  if (!API.user) return;
  setConnDot('reconnecting');
  const url = '/api/stream' + (lastSeq ? '?since=' + lastSeq : '');
  es = new EventSource(url);
  const onEvent = ev => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    lastSeq = data.seq;
    dispatchStream(data);
  };
  ['order.created', 'order.updated', 'order.paid', 'order.voided', 'menu.updated']
    .forEach(type => es.addEventListener(type, onEvent));
  es.onopen = () => { reconnectDelay = 1000; setConnDot('connected'); };
  es.onerror = () => {
    setConnDot('offline');
    if (es) { es.close(); es = null; }
    // EventSource's own auto-retry is a fixed ~3s; we want our own backoff so a
    // downed server doesn't get hammered every 3s forever.
    reconnectTimer = setTimeout(connectStream, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
}

export function disconnectStream() {
  clearTimeout(reconnectTimer);
  clearTimeout(debounceTimer);
  if (es) { es.close(); es = null; }
  reconnectDelay = 1000;
  setConnDot('offline');
}
