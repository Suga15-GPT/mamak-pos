import { $, esc, toast, onStreamEvent, stateWords, minsSince, ageClass, ask } from './state.js';
import { setPendingCount } from './nav.js';

/* ===== KITCHEN DISPLAY =====
   Works station tickets, not dining orders. One ticket is "what this station
   has to make for this round of this table" — so an add-on appears as its own
   fresh ticket in NEW while the table's earlier round sits in SERVED, which is
   exactly the thing the old order-level display could not express. */

// Void ids already flashed once, so a later refresh doesn't replay the
// animation for a void the cook has already seen.
const flashedVoids = new Set();
// ticketId -> the status to revert to if "Undo" is tapped within the window.
const recentAdvance = new Map();
const UNDO_WINDOW_MS = 6000;

// Only the obvious NEXT action is offered — never three buttons of which two
// are disabled (master spec §41).
const NEXT = {
  sent:      { status: 'preparing', label: '🍳 Start cooking', cls: '' },
  preparing: { status: 'ready',     label: '✅ Ready',          cls: 'sage' },
  ready:     { status: 'served',    label: '🍽 Served',         cls: 'charcoal' },
};

let stations = [];
let activeStation = null;

async function loadStations() {
  if (stations.length) return;
  try {
    stations = await API.get('/api/kitchen/stations');
    activeStation = activeStation || stations[0]?.code || null;
  } catch (e) { stations = []; }
}

function renderStationTabs() {
  // One station is not a choice; hide the switcher entirely rather than showing
  // a single tab nobody can act on.
  $('station-tabs').style.display = stations.length > 1 ? '' : 'none';
  $('station-tabs').innerHTML = stations.map(s =>
    `<button class="${s.code === activeStation ? 'active' : ''}"
       aria-pressed="${s.code === activeStation}" data-action="set-station" data-id="${esc(s.code)}">${esc(s.name)}</button>`
  ).join('');
}

function ticketHtml(t) {
  const mins = minsSince(t.sent_at);
  const hasVoid = t.items.some(i => i.voided);
  const key = `${t.id}`;
  const newlyVoided = hasVoid && !flashedVoids.has(key);
  if (hasVoid) flashedVoids.add(key);
  const next = NEXT[t.status];
  const undo = recentAdvance.get(t.id);
  const time = new Date(t.sent_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const who = t.source === 'qr' ? 'CUSTOMER QR' : (t.sent_by_name || 'staff');

  return `<div class="k-order ${esc(t.status)}${hasVoid ? ' has-void' : ''}${newlyVoided ? ' void-flash' : ''}">
    <div class="head">
      <div>
        <div class="k-where">${esc(t.table || `Takeaway #${t.order_id}`)}</div>
        <div class="k-when">Sent ${esc(time)} · by ${esc(who)}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
        ${t.is_addon ? `<span class="badge addon">Add-on · Round ${t.round}</span>` : ''}
        ${t.source === 'qr' ? '<span class="badge qr">QR</span>' : ''}
        <span class="badge ${ageClass(mins)}">⏱ ${mins} min</span>
        ${hasVoid ? '<span class="badge void">Void</span>' : ''}
      </div>
    </div>
    <ul>${t.items.map(i => `<li class="${i.voided ? 'voided' : ''}">${i.qty}× ${esc(i.name)}
      ${i.mods.length || i.note ? `<small>${esc([...i.mods, i.note].filter(Boolean).join(' · '))}</small>` : ''}
      ${i.voided ? `<small>VOIDED: ${esc(i.void_reason || '')}</small>` : ''}</li>`).join('')}</ul>
    ${next ? `<button class="btn k-next ${next.cls}" data-action="advance" data-id="${t.id}" data-status="${next.status}">${next.label}</button>` : ''}
    ${undo ? `<button class="k-undo" data-action="undo" data-id="${t.id}">↶ Undo</button>` : ''}
    <details class="k-history">
      <summary>Who handled this</summary>
      <div class="meta">Sent ${esc(time)} · ${esc(who)}</div>
      ${(t.history || []).map(h => `<div class="meta">${esc(new Date(h.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))} · ${esc(h.what)}${h.who ? ` · ${esc(h.who)}` : ''}</div>`).join('')}
    </details>
  </div>`;
}

/* One sentence above the board: how much is actually outstanding, and whether
   anything has been waiting too long. The columns carry the detail. */
function renderKitchenSummary(tickets) {
  const el = $('kitchen-summary');
  if (!el) return;
  const live = tickets.filter(t => t.status !== 'served');
  if (!live.length) { el.textContent = 'Nothing waiting — the board is clear.'; return; }
  const oldest = Math.max(...live.map(t => minsSince(t.sent_at)));
  const late = live.filter(t => minsSince(t.sent_at) >= 10).length;
  el.textContent = `${live.length} ticket${live.length === 1 ? '' : 's'} on · oldest ${oldest} min`
    + (late ? ` · ${late} over 10 min` : '');
}

function fill(colId, countId, tickets) {
  $(colId).innerHTML = tickets.map(ticketHtml).join('') || '<div class="empty" style="padding:16px">Nothing here</div>';
  $(countId).textContent = tickets.length;
}

export async function refreshKitchen() {
  await loadStations();
  renderStationTabs();
  if (!activeStation) {
    $('k-col-sent').innerHTML = '<div class="empty">No preparation stations configured</div>';
    return;
  }
  try {
    const { tickets } = await API.get(`/api/kitchen/tickets?station=${encodeURIComponent(activeStation)}`);
    // A ticket carrying an unseen void sorts to the top: catching it before the
    // wrong dish goes out is the entire point of a void.
    const sorted = tickets.slice().sort((a, b) => {
      const av = a.items.some(i => i.voided), bv = b.items.some(i => i.voided);
      if (av !== bv) return av ? -1 : 1;
      return new Date(a.sent_at) - new Date(b.sent_at);
    });
    fill('k-col-sent', 'k-count-sent', sorted.filter(t => t.status === 'sent'));
    fill('k-col-preparing', 'k-count-preparing', sorted.filter(t => t.status === 'preparing'));
    fill('k-col-ready', 'k-count-ready', sorted.filter(t => t.status === 'ready'));
    fill('k-col-served', 'k-count-served', sorted.filter(t => t.status === 'served').reverse());
    renderKitchenSummary(sorted);
  } catch (e) { console.error(e); }

  await refreshPending();
}

/* ===== QR APPROVAL QUEUE =====
   Empty (and invisible) unless an admin turned on "Require staff approval". */
async function refreshPending() {
  let pending = [];
  try { pending = await API.get('/api/kitchen/pending'); } catch (e) { pending = []; }
  setPendingCount(pending.length);
  if (!pending.length) { $('kitchen-pending').innerHTML = ''; return; }
  $('kitchen-pending').innerHTML = `<div class="card" style="border-color:var(--info);margin-bottom:16px">
    <h3>⏳ Customer orders waiting for you</h3>
    <p class="meta" style="margin:-8px 0 12px">Nothing here has reached the kitchen or a printer yet.</p>
    ${pending.map(p => `
      <div class="admin-row">
        <div>
          <b>${esc(p.table || `Takeaway #${p.order_id}`)}</b>
          <span class="badge qr">Customer QR</span>
          <div class="meta">${p.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</div>
        </div>
        <div class="row-actions">
          <button class="btn small sage" data-action="approve-send" data-id="${p.id}">✅ Accept &amp; send</button>
          <button class="btn-danger" data-action="reject-send" data-id="${p.id}">❌ Reject</button>
        </div>
      </div>`).join('')}
  </div>`;
}

async function advance(ticketId, status, from) {
  try {
    await API.patch(`/api/kitchen/tickets/${ticketId}`, { status });
    clearTimeout(recentAdvance.get(ticketId)?.timer);
    const timer = setTimeout(() => { recentAdvance.delete(ticketId); refreshKitchen(); }, UNDO_WINDOW_MS);
    recentAdvance.set(ticketId, { from, timer });
    refreshKitchen();
  } catch (e) { toast(e.message); }
}

async function undo(ticketId) {
  const entry = recentAdvance.get(ticketId);
  if (!entry) return;
  clearTimeout(entry.timer);
  recentAdvance.delete(ticketId);
  try {
    await API.patch(`/api/kitchen/tickets/${ticketId}`, { status: entry.from });
    toast('Undone');
  } catch (e) {
    // The 'kitchen' role is blocked from backward transitions server-side —
    // fail loudly rather than silently doing nothing.
    toast(e.status === 403 ? 'Undo needs a staff or admin login on this screen' : e.message);
  }
  refreshKitchen();
}

async function approveSend(id) {
  try { await API.post(`/api/kitchen/sends/${id}/approve`, {}); toast('Sent to the kitchen'); refreshKitchen(); }
  catch (e) { toast(e.message); }
}

async function rejectSend(id) {
  const reason = await ask({
    title: 'Reject this customer order?',
    hint: 'The customer is told, and the items are voided on the bill — not silently dropped.',
    placeholder: 'e.g. item finished for today', ok: 'Reject',
  });
  if (reason === null) return;
  try { await API.post(`/api/kitchen/sends/${id}/reject`, { reason }); toast('Rejected'); refreshKitchen(); }
  catch (e) { toast(e.message); }
}

$('tab-kitchen').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'set-station') { activeStation = el.dataset.id; refreshKitchen(); }
  else if (a === 'advance') {
    const from = { preparing: 'sent', ready: 'preparing', served: 'ready' }[el.dataset.status];
    advance(Number(el.dataset.id), el.dataset.status, from);
  } else if (a === 'undo') undo(Number(el.dataset.id));
  else if (a === 'approve-send') approveSend(Number(el.dataset.id));
  else if (a === 'reject-send') rejectSend(Number(el.dataset.id));
});

/* Realtime: refresh the moment anything changes, without waiting for a poll —
   this is the screen latency is felt on most. */
onStreamEvent(() => {
  if (document.getElementById('tab-kitchen')?.classList.contains('active')) refreshKitchen();
});

// Elapsed minutes drive the age badge, so the display re-renders every 30s even
// with no events at all — a ticket must go late on its own.
setInterval(() => {
  if (document.getElementById('tab-kitchen')?.classList.contains('active')) refreshKitchen();
}, 30000);
