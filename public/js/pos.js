import { state, $, fmt, esc, toast, onStreamEvent, stateWords, minsSince, ask } from './state.js';
import { enqueue, pending as outboxPending, onOutboxChange, resultFor } from './outbox.js';

/* ===== DATA LOADING ===== */
export async function loadAll() {
  try {
    [state.menu, state.tables] = await Promise.all([API.get('/api/menu'), API.get('/api/tables')]);
    state.activeCat = state.menu.categories[0]?.id;
    renderTables();
    renderMenu();
    renderFavs();
  } catch (e) { toast('Failed to load data: ' + e.message); }
}

/* ===== THE FLOOR =====
   Table state is read off the order's rounds, not off one global kitchen
   status: a table can hold round 1 served and round 2 cooking at the same
   time, and what the waiter needs to see is the most urgent of the two
   (master spec §14). Every tile is the same size and says its state in words —
   colour is a shortcut for people who already know it, never the message. */
const TILE_STATE = {
  sent:      { cls: 'new-order' },
  preparing: { cls: 'preparing' },
  ready:     { cls: 'ready' },
  served:    { cls: 'ready-to-pay', label: 'Ready to pay', icon: '💵' },
};

function tileHtml({ key, name, order, action, id }) {
  if (!order) {
    return `<button class="table-btn free" data-action="${action}" data-id="${id}" id="${key}">
      <span class="t-name">${esc(name)}</span>
      <span class="t-state">${stateWords('free').label}</span>
    </button>`;
  }
  const conf = TILE_STATE[order.status] || {};
  const words = stateWords(order.status);
  const mins = minsSince(order.updated_at);
  const items = (order.items || []).filter(i => !i.voided).reduce((s, i) => s + i.qty, 0);
  const total = order.grand_total != null ? order.grand_total : order.total;
  const pending = (order.sends || []).filter(s => s.approval_state === 'pending').length;
  const stale = mins >= 30 ? ' stale' : '';
  return `<button class="table-btn ${conf.cls || ''}${stale}" data-action="${action}" data-id="${id}" id="${key}">
    <span class="t-name">${esc(name)}</span>
    <span class="t-state">${conf.icon || words.icon} ${esc(conf.label || words.label)}</span>
    <span class="t-sub">${mins} min · ${items} item${items === 1 ? '' : 's'}${stale ? ' · check this table' : ''}</span>
    ${pending ? `<span class="t-sub">⏳ ${pending} waiting for you</span>` : ''}
    <span class="t-total">${fmt(total)}</span>
  </button>`;
}

/* Coming back to the floor tab while a table's bill is open should return to
   that bill, not throw the waiter back to the grid mid-order — but it must
   re-read the order first, because the kitchen may have moved it on while they
   were away. */
export function refreshPos() {
  if (state.selTable) return checkOpenOrder();
  return renderTables();
}

export async function renderTables() {
  let orders = [];
  try { orders = await API.get('/api/orders'); } catch (e) { /* offline: render the empty floor */ }

  // GET /api/orders (no mode=) already excludes paid/cancelled/refunded, and the
  // DB enforces at most one open order per table, so this is unambiguous.
  const byTable = {};
  orders.forEach(o => { if (o.table_id) byTable[o.table_id] = o; });

  $('tables-grid').innerHTML = state.tables
    .map(t => tileHtml({ key: `tb-${t.id}`, name: t.name, order: byTable[t.id], action: 'select-table', id: t.id }))
    .join('') || '<div class="empty">No tables set up yet — add them in Admin → Tables &amp; QR.</div>';

  // Takeaway is its own section, not a tile pretending to be a table.
  const takeaway = orders.filter(o => o.order_type === 'takeaway');
  $('takeaway-grid').innerHTML = takeaway
    .map(o => tileHtml({ key: `ta-${o.id}`, name: o.label, order: o, action: 'select-takeaway', id: o.id }))
    .join('') || '<div class="empty" style="grid-column:1/-1">No takeaway orders right now.</div>';
}

/* ===== WORKSPACE ===== */
// The live server order backing the current cart (once one exists) — carries the
// always-current subtotal/service_charge/tax/grand_total the bill panel mirrors,
// so the client never recomputes tax itself.
let liveOrder = null;
// The outbox entry that is creating this workspace's order, if it hasn't
// landed yet.
let pendingCreateEntry = null;

function openWorkspace(sel) {
  state.selTable = sel;
  state.cart = [];
  liveOrder = null;
  pendingCreateEntry = null;
  searchQuery = '';
  $('item-search').value = '';
  $('pos-tables').style.display = 'none';
  $('pos-workspace').style.display = '';
  $('ws-title').textContent = sel.name;
  $('ws-state').innerHTML = '';
  $('move-order-btn').style.display = 'none';
  renderCart();
  renderMenu();
  renderFavs();
  checkOpenOrder();
}

function selectTable(id) {
  const t = state.tables.find(x => x.id === id);
  openWorkspace({ type: 'dine_in', tableId: id, name: t ? t.name : '', orderId: null });
}

function selectTakeaway(orderId) {
  openWorkspace({ type: 'takeaway', tableId: null, name: `Takeaway #${orderId}`, orderId });
}

function newTakeaway() {
  openWorkspace({ type: 'takeaway', tableId: null, name: 'New takeaway', orderId: null });
}

function backToTables() {
  $('pos-workspace').style.display = 'none';
  $('pos-tables').style.display = '';
  state.selTable = null;
  state.cart = [];
  liveOrder = null;
  renderTables();
}

async function checkOpenOrder() {
  if (!state.selTable) return;
  // A brand-new takeaway ticket has no table to look itself up by, so it learns
  // its order id from the outbox entry that created it — which is also the only
  // path that works when the create was queued offline and landed later.
  if (pendingCreateEntry && !state.selTable.orderId) {
    const result = resultFor(pendingCreateEntry);
    if (result) { state.selTable.orderId = result.id; pendingCreateEntry = null; }
  }
  // A line queued in the outbox is shown as "sending" until the outbox has
  // actually delivered it. Once the entry leaves the queue the server's own
  // copy takes over — keeping both would show the item twice.
  const stillQueued = new Set((await outboxPending().catch(() => [])).map(e => e.id));

  try {
    const orders = await API.get('/api/orders');
    const sel = state.selTable;
    const open = sel.type === 'takeaway'
      ? orders.find(o => o.id === sel.orderId)
      : orders.find(o => o.table_id === sel.tableId);

    // Keep whatever the server hasn't confirmed yet — lines still being typed
    // AND lines queued in the offline outbox (sent === 'pending') — and replace
    // everything the server already knows about with the server's own version.
    // Treating 'pending' as sent here dropped queued lines on the floor the
    // moment the outbox fired while offline.
    const unsent = state.cart.filter(l =>
      l.sent !== true && (l.sent !== 'pending' || stillQueued.has(l.entry)));
    if (open) {
      liveOrder = open;
      state.selTable.orderId = open.id;
      if (sel.type === 'takeaway') { state.selTable.name = open.label; $('ws-title').textContent = open.label; }
      state.cart = open.items.map(l => ({
        id: l.id, item_id: l.item_id || 0, name: l.name, price: l.price, qty: l.qty, mods: l.mods,
        note: l.note || '', seat: l.seat, sent: true, voided: l.voided, void_reason: l.void_reason,
        round: l.round, round_status: l.round_status, station: l.station, send_id: l.send_id,
      })).concat(unsent);
      $('pay-btn').style.display = '';
      $('pay-btn').dataset.orderId = open.id;
      $('pay-btn').dataset.orderStatus = open.status;
      $('move-order-btn').style.display = '';
      const w = stateWords(open.status);
      $('ws-state').innerHTML = `<span class="badge ${esc(open.status)}">${w.icon} ${esc(w.label)}</span>`;
    } else {
      liveOrder = null;
      state.cart = unsent;
      $('pay-btn').style.display = 'none';
      $('move-order-btn').style.display = 'none';
      $('ws-state').innerHTML = '';
    }
    renderCart();
  } catch (e) { /* offline — keep showing what we have */ }
}

/* ===== MENU ===== */
// A mamak menu can run to 200 items — scrolling category-by-category isn't a
// search strategy, so a non-empty query searches the whole menu by name and
// ignores the active category rather than filtering within it.
let searchQuery = '';
let favIds = new Set();

function itemButton(it, extraClass = '') {
  const station = state.menu.stations?.find(s => s.code === it.station_code);
  return `<button class="item-btn ${extraClass}" data-action="add-item" data-id="${it.id}">
    <span class="nm">${esc(it.name)}</span>
    ${station && station.code !== 'kitchen' ? `<span class="st">${esc(station.name)}</span>` : ''}
    <span class="pr">${fmt(it.price)}</span></button>`;
}

function renderMenu() {
  if (!state.activeCat && state.menu.categories.length) state.activeCat = state.menu.categories[0].id;
  $('menu-cats').innerHTML = state.menu.categories.map(c =>
    `<button class="${c.id === state.activeCat ? 'active' : ''}"
       aria-pressed="${c.id === state.activeCat}" data-action="set-cat" data-id="${c.id}">${esc(c.name)}</button>`
  ).join('');
  // The selected tab must be visible: on a phone the active category is often
  // scrolled off the right-hand end after a tap.
  const active = $('menu-cats').querySelector('button.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });

  $('menu-favs').style.display = searchQuery ? 'none' : '';
  const items = searchQuery
    ? state.menu.items.filter(i => i.name.toLowerCase().includes(searchQuery))
    : state.menu.items.filter(i => i.category_id === state.activeCat && !favIds.has(i.id));
  $('menu-items').innerHTML = items.map(it => itemButton(it)).join('')
    || `<div class="empty">${searchQuery ? 'No items match your search' : 'No items in this category'}</div>`;
}

function setSearch(q) { searchQuery = q.trim().toLowerCase(); renderMenu(); }

// Top-selling-today row (already computed server-side) turns three taps into
// one for the handful of items that cover most orders.
async function renderFavs() {
  try {
    const s = await API.get('/api/dashboard');
    const favs = (s.top_items || []).slice(0, 6)
      .map(t => state.menu.items.find(i => i.name === t.name))
      .filter(Boolean);
    favIds = new Set(favs.map(f => f.id));
    $('menu-favs').innerHTML = favs.length
      ? `<div class="favs-label">🔥 Popular today</div>
         <div class="menu-items favs-row">${favs.map(it => itemButton(it, 'fav')).join('')}</div>`
      : '';
  } catch (e) { $('menu-favs').innerHTML = ''; favIds = new Set(); }
  renderMenu();
}

/* ===== CART =====
   Tapping an item adds it. A remark is a secondary action on the line that is
   already in the bill, not a dialog standing between the waiter and every
   single order (master spec §36). Configured food options are different: those
   are rules the kitchen depends on, so they still ask. */
function addItem(id) {
  const it = state.menu.items.find(i => i.id === id);
  if (!it) return;
  if ((it.modifier_group_ids || []).length) return openModifierModal(it);
  addLine(it, [], '');
}

function addLine(it, mods, note) {
  const same = state.cart.find(l => !l.sent && l.item_id === it.id && l.note === note
    && l.mods.length === mods.length && l.mods.every((m, i) => m.name === mods[i].name));
  if (same) same.qty++;
  else state.cart.push({ item_id: it.id, name: it.name, price: it.price, qty: 1, mods, note, station: it.station_code });
  renderCart();
}

function cartQty(idx, d) {
  const line = state.cart[idx];
  if (!line || line.sent) return toast('Already sent to the kitchen');
  line.qty = line.qty + d;
  if (line.qty < 1) state.cart.splice(idx, 1);
  renderCart();
}
function cartDel(idx) {
  if (state.cart[idx]?.sent) return toast('Already sent — void it instead');
  state.cart.splice(idx, 1);
  renderCart();
}

const PRESETS_DRINK = ['Kurang manis', 'Tak nak ais', 'Less ice', 'Extra hot'];
const PRESETS_FOOD = ['Kurang pedas', 'Tambah telur', 'Tak nak bawang', 'Kurang minyak', 'Banjir'];

function presetsFor(line) {
  return line.station === 'drinks' ? PRESETS_DRINK : PRESETS_FOOD;
}

let noteTargetIdx = null;
function openNote(idx) {
  const line = state.cart[idx];
  if (!line || line.sent) return;
  noteTargetIdx = idx;
  $('remark-title').textContent = line.name;
  $('remark-input').value = line.note || '';
  $('remark-presets').innerHTML = presetsFor(line).map(p =>
    `<button class="btn small outline" data-action="set-remark" data-value="${esc(p)}">${esc(p)}</button>`).join('');
  $('remark-modal').classList.add('show');
  setTimeout(() => $('remark-input').focus(), 60);
}
function closeRemarkModal() { $('remark-modal').classList.remove('show'); noteTargetIdx = null; }
function saveNote(note) {
  if (noteTargetIdx != null && state.cart[noteTargetIdx]) state.cart[noteTargetIdx].note = note;
  closeRemarkModal();
  renderCart();
}

function lineHtml(l, i) {
  const lt = (l.price + l.mods.reduce((s, m) => s + m.price, 0)) * l.qty;
  const modStr = l.mods.map(m => m.name + (m.price ? ` +${fmt(m.price)}` : '')).join(', ');
  const sub = [modStr, l.note ? `📝 ${l.note}` : '', l.seat != null ? `Seat ${l.seat}` : '']
    .filter(Boolean).map(esc).join(' · ');

  let right;
  if (l.voided) right = '';
  else if (l.sent === 'pending') right = '<span class="round-tag pending">⏳ sending</span>';
  else if (l.sent) right = `<button data-action="void-line" data-id="${i}">❌ Void</button>`;
  else right = `<div class="qty">
      <button data-action="cart-qty" data-id="${i}" data-delta="-1" aria-label="One fewer">−</button>
      <button data-action="cart-qty" data-id="${i}" data-delta="1" aria-label="One more">+</button>
      <button data-action="open-note" data-id="${i}" aria-label="Add a remark">📝</button>
      <button data-action="cart-del" data-id="${i}" aria-label="Remove">✕</button>
    </div>`;

  return `<div class="cart-line"${l.voided || l.sent === 'pending' ? ' style="opacity:.6"' : ''}>
    <div>
      <div class="line-name">${l.qty}× ${esc(l.name)}${l.voided ? ' <span class="round-tag voided">Voided</span>' : ''}</div>
      ${sub ? `<div class="line-sub">${sub}</div>` : ''}
      ${l.voided && l.void_reason ? `<div class="line-sub">${esc(l.void_reason)}</div>` : ''}
      ${!l.sent && !l.voided ? `<input type="number" min="1" placeholder="Seat" value="${l.seat ?? ''}"
          data-action="set-seat" data-id="${i}" style="width:76px;margin-top:6px;font-size:14px;padding:6px 8px;min-height:36px">` : ''}
    </div>
    <div class="line-right"><span${l.voided ? ' style="text-decoration:line-through"' : ''}>${fmt(lt)}</span>${right}</div>
  </div>`;
}

/* The bill is split the way the waiter thinks about it: what the kitchen
   already has (grouped by the round it went in, with that round's state) and
   what is still sitting on this screen (master spec §15). */
function renderCart() {
  const sentLines = state.cart.map((l, i) => [l, i]).filter(([l]) => l.sent === true);
  const newLines = state.cart.map((l, i) => [l, i]).filter(([l]) => l.sent !== true);

  if (!state.cart.length) {
    $('cart-body').innerHTML = '';
    $('cart-empty').style.display = '';
    $('cart-totals').style.display = 'none';
    $('round-timeline').style.display = 'none';
  } else {
    $('cart-empty').style.display = 'none';
    $('cart-totals').style.display = '';
    let html = '';

    if (sentLines.length) {
      const rounds = new Map();
      sentLines.forEach(([l, i]) => {
        const key = l.round || 0;
        if (!rounds.has(key)) rounds.set(key, []);
        rounds.get(key).push([l, i]);
      });
      html += `<div class="bill-group-head"><span>✅ Already sent</span></div>`;
      [...rounds.keys()].sort((a, b) => a - b).forEach(round => {
        const lines = rounds.get(round);
        const st = lines.find(([l]) => l.round_status)?.[0].round_status;
        const w = stateWords(st || 'sent');
        html += `<div class="bill-group-head" style="margin-top:10px">
            <span>Round ${round}</span><span class="round-tag ${esc(st || '')}">${w.icon} ${esc(w.label)}</span></div>`;
        html += lines.map(([l, i]) => lineHtml(l, i)).join('');
      });
    }

    if (newLines.length) {
      html += `<div class="bill-group-head"><span>🆕 New items — not sent yet</span></div>`;
      html += newLines.map(([l, i]) => lineHtml(l, i)).join('');
    }
    $('cart-body').innerHTML = html;
  }

  // Subtotal/service charge/SST come straight from the live order's
  // server-computed bill — never recomputed here. Lines added but not yet sent
  // have no server figures, so their raw price is folded into subtotal/total.
  let rawTotal = 0, unsentSubtotal = 0;
  state.cart.forEach(l => {
    const lt = (l.price + l.mods.reduce((s, m) => s + m.price, 0)) * l.qty;
    if (l.voided) return;
    rawTotal += lt;
    if (l.sent !== true) unsentSubtotal += lt;
  });
  const bill = liveOrder && liveOrder.subtotal != null ? liveOrder : null;
  $('cart-subtotal-rm').textContent = fmt(bill ? bill.subtotal + unsentSubtotal : rawTotal);
  $('cart-svc-row').style.display = bill && bill.service_charge ? '' : 'none';
  $('cart-svc-rm').textContent = fmt(bill ? bill.service_charge : 0);
  $('cart-tax-rm').textContent = fmt(bill ? bill.tax : 0);
  $('cart-total-rm').textContent = fmt(bill ? bill.grand_total + unsentSubtotal : rawTotal);

  // The primary action says exactly what it will do, and how much of it.
  const count = newLines.filter(([l]) => l.sent !== 'pending').reduce((s, [l]) => s + l.qty, 0);
  const btn = $('send-btn');
  btn.disabled = count === 0;
  btn.innerHTML = count === 0
    ? '🍳 <span>Send to Kitchen</span>'
    : `🍳 <span>Send ${count} new item${count === 1 ? '' : 's'} to kitchen</span>`;

  renderTimeline();
}

/* A compact history, deliberately secondary — collapsed until asked for. */
function renderTimeline() {
  const sends = liveOrder?.sends || [];
  if (sends.length < 1) { $('round-timeline').style.display = 'none'; return; }
  $('round-timeline').style.display = '';
  $('round-timeline-body').innerHTML = sends.map(s => {
    const count = s.item_ids.length;
    const time = new Date(s.sent_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const states = s.approval_state === 'pending'
      ? '<span class="round-tag pending">⏳ Waiting for staff</span>'
      : s.tickets.map(t => {
          const w = stateWords(t.status);
          return `<span class="round-tag ${esc(t.status)}">${esc(t.station_name)}: ${w.icon} ${esc(w.label)}</span>`;
        }).join(' ');
    return `<div class="cart-line"><div>
        <div class="line-name">Round ${s.seq_no} · ${esc(time)}</div>
        <div class="line-sub">${count} item${count === 1 ? '' : 's'} · by ${esc(s.source === 'qr' ? 'Customer QR' : (s.sent_by_name || 'staff'))}</div>
      </div><div class="line-right">${states}</div></div>`;
  }).join('');
}

function setSeat(idx, value) {
  if (state.cart[idx]?.sent) return;
  const n = parseInt(value);
  state.cart[idx].seat = n > 0 ? n : null;
}

async function voidLine(idx) {
  const line = state.cart[idx];
  if (!line || !line.sent || line.voided) return;
  // Voids require server confirmation and must fail loudly offline — a
  // mis-queued void is a cash discrepancy nobody could reconstruct later.
  if (!navigator.onLine) return toast('Cannot void a line while offline');
  const reason = await ask({
    title: `Void ${line.name}?`,
    hint: 'Say why — this is recorded, and the kitchen gets a void slip.',
    placeholder: 'e.g. customer changed their mind', ok: 'Void it',
  });
  if (reason === null) return;
  if (reason.length < 3) return toast('Please give a reason (at least 3 characters)');
  try {
    await API.post(`/api/orders/${state.selTable.orderId}/items/${line.id}/void`, { reason });
    toast('Line voided');
    checkOpenOrder();
  } catch (e) { toast('Void failed: ' + e.message); }
}

/* ===== FOOD OPTIONS MODAL ===== */
function modifierGroupsFor(it) {
  return (it.modifier_group_ids || [])
    .map(gid => state.menu.modifier_groups.find(g => g.id === gid))
    .filter(Boolean);
}

function openModifierModal(it) {
  state.modItem = it;
  $('mod-title').textContent = `${it.name} — ${fmt(it.price)}`;
  $('mod-body').innerHTML = modifierGroupsFor(it).map(g => {
    const opts = state.menu.modifier_options.filter(o => o.group_id === g.id);
    const inputType = g.mode === 'radio' ? 'radio' : 'checkbox';
    const label = g.min_select > 0
      ? `${esc(g.name)} — choose ${g.min_select === g.max_select ? g.min_select : `${g.min_select}–${g.max_select}`}`
      : `${esc(g.name)} — optional`;
    return `<div class="label" style="margin:14px 0 6px">${label}</div>` + opts.map(o =>
      `<label class="mod-opt"><input type="${inputType}" name="grp-${g.id}" data-group="${g.id}" value="${o.id}">
        <span style="flex:1">${esc(o.name)}</span>
        ${o.price ? `<span style="color:var(--terra-deep);font-weight:800">+${fmt(o.price)}</span>` : ''}</label>`).join('');
  }).join('');
  $('mod-remark').value = '';
  $('mod-presets').innerHTML = (it.station_code === 'drinks' ? PRESETS_DRINK : PRESETS_FOOD).map(p =>
    `<button class="btn small outline" data-action="set-mod-remark" data-value="${esc(p)}">${esc(p)}</button>`).join('');
  updateModifierValidity();
  $('modal-bg').classList.add('show');
}

function updateModifierValidity() {
  const btn = $('mod-confirm-btn');
  if (!state.modItem || !btn) return;
  btn.disabled = !modifierGroupsFor(state.modItem).every(g => {
    const count = document.querySelectorAll(`input[data-group="${g.id}"]:checked`).length;
    return count >= g.min_select && count <= g.max_select;
  });
}

function closeModal() { $('modal-bg').classList.remove('show'); state.modItem = null; }

function confirmModifiers() {
  if (!state.modItem) return;
  const mods = [];
  modifierGroupsFor(state.modItem).forEach(g => {
    document.querySelectorAll(`input[data-group="${g.id}"]:checked`).forEach(inp => {
      const o = state.menu.modifier_options.find(x => x.id == inp.value);
      if (o) mods.push({ name: o.name, price: o.price });
    });
  });
  const it = state.modItem;
  const note = $('mod-remark').value.trim();
  closeModal();
  state.cart.push({ item_id: it.id, name: it.name, price: it.price, qty: 1, mods, note, station: it.station_code });
  renderCart();
}

/* ===== SEND =====
   Writes through the outbox: enqueue and return immediately — the waiter is
   never blocked on the network. An append opens a NEW kitchen round server-side
   (routes/orders.js), which is what stops an add-on inheriting the earlier
   round's state. */
async function sendOrder() {
  const sel = state.selTable;
  if (!sel) return;
  const toSend = state.cart.filter(l => !l.sent);
  if (!toSend.length) return toast('Nothing new to send');

  const items = toSend.map(l => ({
    item_id: l.item_id,
    qty: l.qty,
    note: l.note,
    seat: l.seat || null,
    modifier_option_ids: l.mods.map(m => {
      const opt = state.menu.modifier_options.find(o => o.name === m.name);
      return opt ? opt.id : null;
    }).filter(Boolean),
  }));

  // liveOrder (kept fresh by checkOpenOrder — selection, realtime events and
  // outbox reconciliation) decides create vs append without needing a fresh
  // round trip that offline can't provide.
  const request = liveOrder
    ? { url: `/api/orders/${liveOrder.id}/items`, method: 'POST', body: { items } }
    : sel.type === 'takeaway'
      ? { url: '/api/orders', method: 'POST', body: { order_type: 'takeaway', items } }
      : { url: '/api/orders', method: 'POST', body: { table_id: sel.tableId, items } };

  const entry = await enqueue(request);
  if (!liveOrder) pendingCreateEntry = entry.id;
  toSend.forEach(l => { l.sent = 'pending'; l.entry = entry.id; });
  renderCart();
  toast(navigator.onLine ? 'Sending to kitchen…' : 'Offline — queued, will send when back online');
}

/* ===== MOVE ORDER ===== */
async function openMove() {
  if (!liveOrder) return;
  const orders = await API.get('/api/orders').catch(() => []);
  const busy = new Set(orders.filter(o => o.table_id).map(o => o.table_id));
  const options = state.tables.filter(t => !busy.has(t.id));
  $('move-target').innerHTML = options.length
    ? options.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')
    : '<option value="">No free table</option>';
  $('move-err').textContent = '';
  $('move-modal').classList.add('show');
}
function closeMove() { $('move-modal').classList.remove('show'); }
async function confirmMove() {
  const tableId = Number($('move-target').value);
  if (!tableId) return;
  try {
    const r = await API.post(`/api/orders/${liveOrder.id}/move`, { table_id: tableId });
    closeMove();
    toast(`Moved to ${r.table}`);
    state.selTable = { type: 'dine_in', tableId, name: r.table, orderId: liveOrder.id };
    $('ws-title').textContent = r.table;
    checkOpenOrder();
  } catch (e) { $('move-err').textContent = e.message; }
}

/* ===== PAYMENT =====
   Everything shown here (subtotal/tax/total/amount_due/payments-so-far) comes
   straight from the order, which the server keeps recomputed on every change —
   no client-side bill math to duplicate or get out of sync. */
let currentOrder = null;
// A split view the cashier is actively working through. Computed once from the
// balance at split time; paying a share removes just that entry, never a fresh
// re-split of the shrinking remainder.
let pendingShares = null;

async function refreshPayModal() {
  const orderId = $('pay-btn').dataset.orderId;
  if (!orderId) return false;
  const orders = await API.get('/api/orders').catch(() => []);
  const order = orders.find(o => o.id == orderId);
  if (!order) return false;
  currentOrder = order;
  renderPayModal();
  return true;
}

async function openPayModal() {
  pendingShares = null;
  if (!(await refreshPayModal())) return toast('Order not found');
  // Only ask once, when the modal is first opened — not on every refresh after
  // a partial payment, which would re-prompt on each split-payment leg.
  if (['sent', 'preparing'].includes(currentOrder.status)) {
    if (!confirm('Food is still being prepared. Take payment anyway?')) return;
  }
  $('pay-modal').classList.add('show');
}

function renderPayModal() {
  const o = currentOrder;
  const rows = [`<div class="totals"><div class="row"><span>Subtotal</span><span>${fmt(o.subtotal)}</span></div>`];
  if (o.service_charge) rows.push(`<div class="row"><span>Service charge</span><span>${fmt(o.service_charge)}</span></div>`);
  rows.push(`<div class="row"><span>SST</span><span>${fmt(o.tax)}</span></div>`);
  if (o.discount) rows.push(`<div class="row"><span>Discount</span><span>-${fmt(o.discount)}</span></div>`);
  rows.push(`<div class="row grand"><span>Total</span><span>${fmt(o.grand_total)}</span></div></div>`);

  if (o.discounts?.length) {
    rows.push('<div class="bill-group-head">Discounts applied</div>');
    o.discounts.forEach(d => {
      const removeBtn = API.user.role === 'admin' && !o.payments?.length
        ? `<button data-action="remove-discount" data-id="${d.id}">Remove</button>` : '';
      rows.push(`<div class="cart-line"><div><div class="line-sub">${esc(d.kind)} — ${esc(d.reason)}</div></div>
        <div class="line-right"><span>-${fmt(d.amount)}</span>${removeBtn}</div></div>`);
    });
  }

  if (o.payments?.length) {
    rows.push('<div class="bill-group-head">Paid so far</div>');
    o.payments.forEach(p => rows.push(
      `<div class="cart-line"><div class="line-sub">${esc(p.method)}</div><div class="line-right">${fmt(p.amount)}</div></div>`));
    // Reprints are a known fraud vector — admin only, and always audited.
    if (API.user.role === 'admin') {
      rows.push('<div style="margin-top:8px"><button class="btn small outline" data-action="reprint-receipt">Reprint receipt</button></div>');
    }
  }

  if (o.refunds?.length) {
    rows.push('<div class="bill-group-head">Refunded</div>');
    o.refunds.forEach(r => rows.push(
      `<div class="cart-line"><div class="line-sub">${esc(r.method)} — ${esc(r.reason)}</div>
        <div class="line-right" style="color:var(--red)">-${fmt(r.amount)}</div></div>`));
  }

  rows.push(`<div class="totals"><div class="row grand"><span>To pay</span><span>${fmt(o.amount_due)}</span></div></div>`);

  $('pay-details').innerHTML = `<div class="meta" style="margin-bottom:8px">${esc(o.label)} · Order #${o.id}</div>${rows.join('')}`;
  $('pay-amount-input').value = '';
  $('cash-received-input').value = '';
  $('pay-change-due').textContent = '';
  $('pay-cash-row').style.display = '';
  $('pay-amount-row').style.display = '';
  closeDiscountForm();
  closeRefundForm();
  $('refund-section').style.display = (o.payments || []).some(p => p.refundable > 0.001) ? '' : 'none';
  renderSplitResult();
}

function renderSplitResult() {
  if (!pendingShares || !pendingShares.items.length) { $('pay-split-result').innerHTML = ''; return; }
  $('pay-split-result').innerHTML = `<div class="bill-group-head">${esc(pendingShares.title)}</div>` +
    pendingShares.items.map((s, i) => `
      <div class="cart-line"><div class="line-name">${esc(s.label)}: ${fmt(s.amount)}</div>
        <div class="line-right">
          <button class="btn small" data-action="pay-share" data-idx="${i}">Pay cash</button>
          <button class="btn small info" data-action="pay-share" data-idx="${i}" data-method="Card">Pay card</button>
        </div></div>`).join('');
}

function closePayModal() { $('pay-modal').classList.remove('show'); currentOrder = null; pendingShares = null; }

function updateChangeDue() {
  if (!currentOrder) return;
  const amount = Number($('pay-amount-input').value || currentOrder.amount_due);
  const receivedCents = Math.round(Number($('cash-received-input').value || 0) * 100);
  const changeCents = receivedCents - Math.round(amount * 100);
  $('pay-change-due').textContent = receivedCents ? `Change: ${fmt(Math.max(0, changeCents) / 100)}` : '';
  $('pay-change-due').style.color = changeCents < 0 ? 'var(--red)' : 'var(--charcoal)';
}

/* method === null pays the full remaining balance; otherwise `amount`/`tendered`
   (RM) pay exactly that much — used for split-by-amount and split-by-seat. */
async function processPay(method, amount, tendered) {
  // Payments require server confirmation and must fail loudly offline — unlike
  // order entry, they are never queued: a mis-queued payment is a cash
  // discrepancy nobody can reconstruct.
  if (!navigator.onLine) return toast('Cannot take payment while offline');
  const orderId = $('pay-btn').dataset.orderId;
  try {
    const body = { method };
    if (amount != null) body.amount = amount;
    if (method === 'Cash' && tendered != null) body.tendered = tendered;
    const r = await API.post(`/api/orders/${orderId}/pay`, body);
    if (r.settled) {
      closePayModal();
      toast(r.change > 0 ? `Paid — change ${fmt(r.change)}` : 'Paid in full');
      backToTables();
    } else {
      toast(`Paid ${fmt(r.paid)} — ${fmt(r.remaining)} left`);
      await refreshPayModal();
    }
  } catch (e) { toast('Payment failed: ' + e.message); }
}

async function payFull(method) {
  const tenderedInput = $('cash-received-input').value;
  if (method === 'Cash' && tenderedInput) {
    const tenderedCents = Math.round(Number(tenderedInput) * 100);
    if (tenderedCents < Math.round(currentOrder.amount_due * 100)) return toast('Cash received is less than the amount due');
    return processPay('Cash', null, Number(tenderedInput));
  }
  return processPay(method, null, null);
}

function payAmount(method) {
  const amount = Number($('pay-amount-input').value);
  if (!(amount > 0)) return toast('Enter an amount to pay');
  if (amount > currentOrder.amount_due + 0.001) return toast('That is more than what is left');
  // tendered is left unset (not forced equal to amount): cash can't physically
  // be tendered in exact sen the way a typed amount can, so when this leg
  // settles the order the server rounds to the nearest 5 sen.
  return processPay(method, amount, null);
}

// Pay off one previously-computed split share; the leg amount is fixed at split
// time, so this never re-derives it from the (now smaller) remaining balance.
async function paySplitShare(idx, method) {
  const share = pendingShares?.items[idx];
  if (!share) return;
  if (!navigator.onLine) return toast('Cannot take payment while offline');
  try {
    const r = await API.post(`/api/orders/${$('pay-btn').dataset.orderId}/pay`, { method, amount: share.amount });
    pendingShares.items.splice(idx, 1);
    if (r.settled) { closePayModal(); toast('Paid in full'); backToTables(); }
    else { toast(`Paid ${fmt(r.paid)} — ${fmt(r.remaining)} left`); await refreshPayModal(); }
  } catch (e) { toast('Payment failed: ' + e.message); }
}

async function splitEvenlyUI() {
  const ways = parseInt(await ask({ title: 'Split evenly', hint: 'How many people are sharing this bill?', value: '2', ok: 'Split' }));
  if (!ways || ways < 1) return;
  try {
    const { shares } = await API.get(`/api/orders/${$('pay-btn').dataset.orderId}/split?ways=${ways}`);
    pendingShares = { title: `${ways}-way split`, items: shares.map((amt, i) => ({ label: `Share ${i + 1}`, amount: amt })) };
    renderSplitResult();
  } catch (e) { toast(e.message); }
}

async function splitBySeatUI() {
  try {
    const { seats } = await API.get(`/api/orders/${$('pay-btn').dataset.orderId}/split?by=seat`);
    const entries = Object.entries(seats);
    if (!entries.length) return toast('No lines have a seat assigned');
    pendingShares = { title: 'By seat', items: entries.map(([seat, amt]) => ({ label: `Seat ${seat}`, amount: amt })) };
    renderSplitResult();
  } catch (e) { toast(e.message); }
}

/* ===== DISCOUNT =====
   Staff need an admin's PIN; admin applies directly. Every path writes its own
   audit row server-side. */
function openDiscountForm() {
  $('discount-form').style.display = '';
  $('discount-kind').value = 'percent';
  ['discount-value', 'discount-reason', 'discount-admin-name', 'discount-admin-pin'].forEach(id => { $(id).value = ''; });
  $('discount-pin-row').style.display = API.user.role === 'admin' ? 'none' : '';
  updateDiscountValueUI();
}
function closeDiscountForm() { $('discount-form').style.display = 'none'; }
function updateDiscountValueUI() {
  const isComp = $('discount-kind').value === 'comp';
  $('discount-value').disabled = isComp;
  $('discount-value').placeholder = $('discount-kind').value === 'percent' ? 'Percent (e.g. 10)' : 'Amount (RM)';
}

async function applyDiscount() {
  if (!currentOrder) return;
  const kind = $('discount-kind').value;
  const value = Number($('discount-value').value || 0);
  const reason = $('discount-reason').value.trim();
  if (kind !== 'comp' && !(value > 0)) return toast('Enter a discount value');
  if (reason.length < 3) return toast('Reason must be at least 3 characters');
  const body = { kind, value, reason };
  try {
    if (API.user.role !== 'admin') {
      const name = $('discount-admin-name').value.trim();
      const pin = $('discount-admin-pin').value.trim();
      if (!name || !pin) return toast('An admin name and PIN are needed to approve a discount');
      body.authorize_token = (await API.post('/api/discounts/authorize', { name, pin })).token;
    }
    await API.post(`/api/orders/${$('pay-btn').dataset.orderId}/discounts`, body);
    toast('Discount applied');
    await refreshPayModal();
  } catch (e) { toast('Discount failed: ' + e.message); }
}

async function removeDiscount(id) {
  try {
    await API.del(`/api/orders/${$('pay-btn').dataset.orderId}/discounts/${id}`);
    toast('Discount removed');
    await refreshPayModal();
  } catch (e) { toast('Remove failed: ' + e.message); }
}

/* ===== REFUND ===== */
function openRefundForm() {
  if (!currentOrder) return;
  const refundable = (currentOrder.payments || []).filter(p => p.refundable > 0.001);
  $('refund-payment').innerHTML = refundable
    .map(p => `<option value="${p.id}">${esc(p.method)} — ${fmt(p.refundable)} refundable</option>`).join('');
  ['refund-amount', 'refund-reason', 'refund-admin-name', 'refund-admin-pin'].forEach(id => { $(id).value = ''; });
  $('refund-pin-row').style.display = API.user.role === 'admin' ? 'none' : '';
  $('refund-form').style.display = '';
}
function closeRefundForm() { $('refund-form').style.display = 'none'; }

async function applyRefund() {
  if (!currentOrder) return;
  const paymentId = Number($('refund-payment').value);
  const amount = Number($('refund-amount').value || 0);
  const reason = $('refund-reason').value.trim();
  if (!paymentId) return toast('No payment left to refund');
  if (!(amount > 0)) return toast('Enter an amount to refund');
  if (reason.length < 3) return toast('Reason must be at least 3 characters');
  const body = { payment_id: paymentId, amount, reason };
  try {
    if (API.user.role !== 'admin') {
      const name = $('refund-admin-name').value.trim();
      const pin = $('refund-admin-pin').value.trim();
      if (!name || !pin) return toast('An admin name and PIN are needed to approve a refund');
      body.authorize_token = (await API.post('/api/discounts/authorize', { name, pin })).token;
    }
    await API.post(`/api/orders/${$('pay-btn').dataset.orderId}/refunds`, body);
    toast('Refund issued');
    await refreshPayModal();
  } catch (e) { toast('Refund failed: ' + e.message); }
}

async function reprintReceipt() {
  if (!confirm('Reprint this receipt? This is logged.')) return;
  try {
    await API.post(`/api/orders/${$('pay-btn').dataset.orderId}/reprint-receipt`, {});
    toast('Receipt reprint queued');
  } catch (e) { toast('Reprint failed: ' + e.message); }
}

/* ===== EVENT WIRING ===== */
$('tab-pos').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'select-table') selectTable(Number(el.dataset.id));
  else if (a === 'select-takeaway') selectTakeaway(Number(el.dataset.id));
  else if (a === 'new-takeaway') newTakeaway();
  else if (a === 'refresh-tables') renderTables();
  else if (a === 'back-to-tables') backToTables();
  else if (a === 'set-cat') { state.activeCat = Number(el.dataset.id); renderMenu(); }
  else if (a === 'add-item') addItem(Number(el.dataset.id));
  else if (a === 'cart-qty') cartQty(Number(el.dataset.id), Number(el.dataset.delta));
  else if (a === 'cart-del') cartDel(Number(el.dataset.id));
  else if (a === 'open-note') openNote(Number(el.dataset.id));
  else if (a === 'void-line') voidLine(Number(el.dataset.id));
  else if (a === 'send-order') sendOrder();
  else if (a === 'open-pay') openPayModal();
  else if (a === 'open-move') openMove();
});

$('tab-pos').addEventListener('change', e => {
  if (e.target.matches('input[data-action="set-seat"]')) setSeat(Number(e.target.dataset.id), e.target.value);
});

$('item-search').addEventListener('input', e => setSearch(e.target.value));

$('modal-bg').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) {
    const a = el.dataset.action;
    if (a === 'set-mod-remark') $('mod-remark').value = el.dataset.value;
    else if (a === 'close-mod-modal') closeModal();
    else if (a === 'confirm-mods') confirmModifiers();
    return;
  }
  if (e.target === $('modal-bg')) closeModal();
});
$('modal-bg').addEventListener('change', e => {
  if (e.target.matches('input[data-group]')) updateModifierValidity();
});

$('remark-modal').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) {
    const a = el.dataset.action;
    if (a === 'set-remark') $('remark-input').value = el.dataset.value;
    else if (a === 'skip-remark') saveNote('');
    else if (a === 'confirm-remark') saveNote($('remark-input').value.trim());
    return;
  }
  if (e.target === $('remark-modal')) closeRemarkModal();
});

$('move-modal').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el?.dataset.action === 'close-move' || e.target === $('move-modal')) closeMove();
  else if (el?.dataset.action === 'confirm-move') confirmMove();
});

$('pay-modal').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) {
    const a = el.dataset.action;
    if (a === 'pay') payFull(el.dataset.method);
    else if (a === 'pay-amount') payAmount(el.dataset.method || 'Cash');
    else if (a === 'pay-share') paySplitShare(Number(el.dataset.idx), el.dataset.method || 'Cash');
    else if (a === 'split-evenly') splitEvenlyUI();
    else if (a === 'split-by-seat') splitBySeatUI();
    else if (a === 'open-discount-form') openDiscountForm();
    else if (a === 'close-discount-form') closeDiscountForm();
    else if (a === 'apply-discount') applyDiscount();
    else if (a === 'remove-discount') removeDiscount(Number(el.dataset.id));
    else if (a === 'open-refund-form') openRefundForm();
    else if (a === 'close-refund-form') closeRefundForm();
    else if (a === 'apply-refund') applyRefund();
    else if (a === 'reprint-receipt') reprintReceipt();
    else if (a === 'close-pay-modal') closePayModal();
    return;
  }
  if (e.target === $('pay-modal')) closePayModal();
});
$('pay-modal').addEventListener('change', e => {
  if (e.target.id === 'discount-kind') updateDiscountValueUI();
});
$('cash-received-input').addEventListener('input', updateChangeDue);

/* Realtime: a change on any table's order updates the floor live, or — if this
   device is inside that order's workspace — its bill and pay button. */
onStreamEvent(batch => {
  if (batch.some(e => e.type === 'menu.updated')) loadAll();
  if (!document.getElementById('tab-pos')?.classList.contains('active')) return;
  if (!state.selTable) renderTables();
  else checkOpenOrder();
});

/* ===== OFFLINE ===== */
async function updateOfflineBanner() {
  const banner = $('offline-banner');
  if (!banner) return;
  const items = await outboxPending();
  if (!navigator.onLine && items.length) {
    banner.textContent = `Offline — ${items.length} order${items.length === 1 ? '' : 's'} waiting to send`;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}
onOutboxChange(() => {
  updateOfflineBanner();
  if (state.selTable) checkOpenOrder();
});
window.addEventListener('online', updateOfflineBanner);
window.addEventListener('offline', updateOfflineBanner);
updateOfflineBanner();
