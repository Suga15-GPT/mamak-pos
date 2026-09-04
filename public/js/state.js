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

/* ===== SHARED VOCABULARY =====
   One place decides what each preparation state is called and which icon goes
   with it, so the table grid, the kitchen display, the bill and the customer
   page never disagree. An icon is never used on its own — the words are the
   label, the icon is the shortcut (master spec §35). */
export const STATE_WORDS = {
  sent:      { icon: '🔔', label: 'New order' },
  preparing: { icon: '🍳', label: 'Cooking' },
  ready:     { icon: '✅', label: 'Ready' },
  served:    { icon: '🍽', label: 'Served' },
  paid:      { icon: '💵', label: 'Paid' },
  pending:   { icon: '⏳', label: 'Waiting for staff' },
  cancelled: { icon: '❌', label: 'Cancelled' },
  refunded:  { icon: '↩', label: 'Refunded' },
  free:      { icon: '', label: 'Free' },
};
export function stateWords(status) { return STATE_WORDS[status] || { icon: '', label: status || '' }; }

// Minutes elapsed since an ISO timestamp, floored, never negative.
export const minsSince = ts => Math.max(0, Math.floor((Date.now() - new Date(ts)) / 60000));

// 0-5 normal, 5-10 attention, 10+ late. The number of minutes is always
// rendered next to this — colour never carries the meaning alone.
export const ageClass = m => (m < 5 ? 'age-fresh' : m < 10 ? 'age-warm' : 'age-late');

/* ===== ASK =====
   A styled replacement for window.prompt(), which is unstyled, cannot be
   translated, and is suppressed outright by some embedded browsers — which
   would have silently made "void a line" impossible on those devices. */
let askResolve = null;
export function ask({ title, hint = '', value = '', placeholder = '', ok = 'OK' }) {
  const modal = $('ask-modal');
  $('ask-title').textContent = title;
  $('ask-hint').textContent = hint;
  $('ask-hint').style.display = hint ? '' : 'none';
  $('ask-err').textContent = '';
  $('ask-input').value = value;
  $('ask-input').placeholder = placeholder;
  $('ask-ok').textContent = ok;
  modal.classList.add('show');
  setTimeout(() => $('ask-input').focus(), 50);
  return new Promise(resolve => { askResolve = resolve; });
}
function closeAsk(value) {
  $('ask-modal').classList.remove('show');
  const r = askResolve; askResolve = null;
  if (r) r(value);
}
if ($('ask-modal')) {
  $('ask-modal').addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (el?.dataset.action === 'ask-ok') return closeAsk($('ask-input').value.trim());
    if (el?.dataset.action === 'ask-cancel' || e.target === $('ask-modal')) return closeAsk(null);
  });
  $('ask-modal').addEventListener('keydown', e => {
    if (e.key === 'Enter') closeAsk($('ask-input').value.trim());
    if (e.key === 'Escape') closeAsk(null);
  });
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
