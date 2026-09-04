import { state, $, fmt, esc, toast, onStreamEvent } from './state.js';
import { enqueue, pending as outboxPending, onOutboxChange } from './outbox.js';

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

/* ===== POS: TABLES =====
   Semantics (audit #33), stated once: grey = free · amber ('pending') = order
   open, food not yet served · green ('ready-to-pay') = served, awaiting
   payment · red outline ('stale') = open 30+ minutes with no status change —
   a waiter should read the floor in one glance from two metres away. */
export async function renderTables() {
  let orders = [];
  try { orders = await API.get('/api/orders'); } catch (e) {}

  // GET /api/orders (no mode=) already excludes paid/cancelled, and the DB
  // enforces at most one open order per table, so this is unambiguous.
  const byTable = {};
  orders.forEach(o => { byTable[o.table_id] = o; });

  $('pos-tables').innerHTML = `<h2 style="margin-bottom:14px">Select a Table</h2>
    <div class="tables-grid">${state.tables.map(t => {
      const o = byTable[t.id];
      let statusClass = '', statusLabel = '';
      if (o) {
        statusClass = o.status === 'served' ? 'ready-to-pay' : 'pending';
        const mins = Math.max(0, Math.floor((Date.now() - new Date(o.updated_at)) / 60000));
        if (mins >= 30) statusClass += ' stale';
        const itemCount = (o.items || []).filter(i => !i.voided).reduce((s, i) => s + i.qty, 0);
        const total = o.grand_total != null ? o.grand_total : o.total;
        statusLabel = `<div class="table-status">${esc(o.status)} · ${mins}m · ${itemCount} item${itemCount === 1 ? '' : 's'}</div>
          <div class="table-total">${fmt(total)}</div>`;
      }
      return `<button class="table-btn ${statusClass}" id="tb-${t.id}" data-action="select-table" data-id="${t.id}">
        ${esc(t.name)}${statusLabel}
      </button>`;
    }).join('')}</div>`;
}

function selectTable(id) {
  const t = state.tables.find(x => x.id === id);
  state.selTable = { id, name: t ? t.name : '' };
  state.cart = [];
  liveOrder = null;
  searchQuery = '';
  $('item-search').value = '';
  $('pos-tables').style.display = 'none';
  $('pos-workspace').style.display = '';
  $('ws-title').textContent = state.selTable.name;
  renderCart();
  renderMenu();
  renderFavs();
  checkOpenOrder();
}

function backToTables() {
  $('pos-workspace').style.display = 'none';
  $('pos-tables').style.display = '';
  state.selTable = null;
  state.cart = [];
  liveOrder = null;
  renderTables();
}

// The live server order backing the current table's cart (once one exists) —
// carries the always-current subtotal/service_charge/tax/grand_total the cart
// panel mirrors, so the client never recomputes tax itself (money.js is the only
// place that knows how tax works).
let liveOrder = null;

async function checkOpenOrder() {
  try {
    const orders = await API.get('/api/orders');
    const open = orders.find(o => o.table_id === state.selTable.id);
    if (open) {
      liveOrder = open;
      /* lines already on the order are marked sent: they must never be re-submitted */
      state.cart = open.items.map(l => ({
        id: l.id, item_id: l.item_id || 0, name: l.name, price: l.price, qty: l.qty, mods: l.mods,
        note: l.note || '', seat: l.seat, sent: true, voided: l.voided, void_reason: l.void_reason,
      }));
      $('pay-btn').dataset.orderStatus = open.status;
      renderCart();
      $('pay-btn').style.display = '';
      $('pay-btn').dataset.orderId = open.id;
    } else {
      liveOrder = null;
      $('pay-btn').style.display = 'none';
    }
  } catch (e) {}
}

/* ===== POS: MENU ===== */
// A mamak menu can run to 200 items — scrolling category-by-category isn't a
// search strategy, so a non-empty query searches the whole menu by name and
// ignores the active category rather than filtering within it.
let searchQuery = '';

function itemButton(it, extraClass = '') {
  return `<button class="item-btn ${extraClass}" data-action="add-item" data-id="${it.id}">
    <div class="nm">${esc(it.name)}</div><div class="pr">${fmt(it.price)}</div></button>`;
}

// Items already shown in the favourites row (below) are left out of the
// category grid — the same item offered as two separate buttons with the
// same name is confusing to tap and ambiguous to a screen reader alike.
let favIds = new Set();

function renderMenu() {
  if (!state.activeCat && state.menu.categories.length) state.activeCat = state.menu.categories[0].id;
  $('menu-cats').innerHTML = state.menu.categories.map(c =>
    `<button class="${c.id === state.activeCat ? 'active' : ''}" data-action="set-cat" data-id="${c.id}">${esc(c.name)}</button>`
  ).join('');
  $('menu-favs').style.display = searchQuery ? 'none' : '';
  const items = searchQuery
    ? state.menu.items.filter(i => i.name.toLowerCase().includes(searchQuery))
    : state.menu.items.filter(i => i.category_id === state.activeCat && !favIds.has(i.id));
  $('menu-items').innerHTML = items.map(it => itemButton(it)).join('')
    || `<div class="empty">${searchQuery ? 'No items match your search' : 'No items in this category'}</div>`;
}

function setSearch(q) { searchQuery = q.trim().toLowerCase(); renderMenu(); }

// Top-selling-today row (from GET /api/summary, already computed server-side)
// turns 3 taps into 1 for the handful of items that cover most orders.
async function renderFavs() {
  try {
    const s = await API.get('/api/summary');
    const favs = (s.top_items || [])
      .map(t => state.menu.items.find(i => i.name === t.name))
      .filter(Boolean);
    favIds = new Set(favs.map(f => f.id));
    $('menu-favs').innerHTML = favs.length
      ? `<div class="favs-label">Popular today</div>
         <div class="menu-items favs-row">${favs.map(it => itemButton(it, 'fav')).join('')}</div>`
      : '';
  } catch (e) { $('menu-favs').innerHTML = ''; favIds = new Set(); }
  renderMenu();
}

/* ===== POS: CART ===== */
function addItem(id) {
  const it = state.menu.items.find(i => i.id === id);
  if (!it) return;
  if ((it.modifier_group_ids || []).length) { openModifierModal(it); return; }

  // Determine preset remarks based on category
  const cat = state.menu.categories.find(c => c.id === it.category_id);
  const catName = cat ? cat.name.toLowerCase() : '';
  let presets = [];

  if (catName.includes('minuman') || catName.includes('drink')) {
    presets = ['Kurang manis', 'Less ice', 'No ice', 'Extra hot', 'Kurang kurang'];
  } else {
    presets = ['Kurang pedas', 'No onion', 'Extra spicy', 'No MSG', 'Kurang minyak'];
  }

  state.pendingRemarkItem = it;
  $('remark-title').textContent = it.name;
  $('remark-presets').innerHTML = presets.map(p =>
    `<button class="btn small outline" data-action="set-remark" data-value="${esc(p)}">${esc(p)}</button>`
  ).join('');
  $('remark-input').value = '';
  $('remark-modal').classList.add('show');
  setTimeout(() => $('remark-input').focus(), 100);
}

function skipRemark() {
  if (state.pendingRemarkItem) {
    const ex = state.cart.find(l => !l.sent && l.item_id === state.pendingRemarkItem.id && !l.mods.length && !l.note);
    if (ex) ex.qty++;
    else state.cart.push({ item_id: state.pendingRemarkItem.id, name: state.pendingRemarkItem.name, price: state.pendingRemarkItem.price, qty: 1, mods: [], note: '' });
    state.pendingRemarkItem = null;
  }
  closeRemarkModal();
  renderCart();
}

function confirmRemark() {
  if (state.pendingRemarkItem) {
    const note = $('remark-input').value.trim();
    const ex = state.cart.find(l => !l.sent && l.item_id === state.pendingRemarkItem.id && !l.mods.length && l.note === note);
    if (ex) ex.qty++;
    else state.cart.push({ item_id: state.pendingRemarkItem.id, name: state.pendingRemarkItem.name, price: state.pendingRemarkItem.price, qty: 1, mods: [], note });
    state.pendingRemarkItem = null;
  }
  closeRemarkModal();
  renderCart();
}

function closeRemarkModal() { $('remark-modal').classList.remove('show'); state.pendingRemarkItem = null; }

function cartQty(idx, d) { if (state.cart[idx].sent) return toast('Already sent to kitchen'); state.cart[idx].qty = Math.max(1, state.cart[idx].qty + d); renderCart(); }
function cartDel(idx) { if (state.cart[idx].sent) return toast('Already sent — cancel the order instead'); state.cart.splice(idx, 1); renderCart(); }

function renderCart() {
  if (!state.cart.length) { $('cart-lines').innerHTML = ''; $('cart-empty').style.display = ''; $('cart-totals').style.display = 'none'; return; }
  $('cart-empty').style.display = 'none'; $('cart-totals').style.display = '';
  let rawTotal = 0, unsentSubtotal = 0;
  $('cart-lines').innerHTML = state.cart.map((l, i) => {
    const lt = (l.price + l.mods.reduce((s, m) => s + m.price, 0)) * l.qty;
    if (!l.voided) rawTotal += lt;
    // A 'pending' line (queued in the outbox, phase 07) isn't reflected in the
    // server's live bill yet either — fold it in the same way as a still-local,
    // never-sent line, until checkOpenOrder() confirms it landed.
    if (!l.voided && l.sent !== true) unsentSubtotal += lt;
    const modStr = l.mods.map(m => m.name + (m.price ? ` +${fmt(m.price)}` : '')).join(', ');
    // A line is 'pending' (queued in the outbox, not yet confirmed by the
    // server — phase 07) or true (server-confirmed sent) or falsy (still local).
    const tag = l.voided
      ? ` <small class="sent-tag" style="color:var(--red)">VOID${l.void_reason ? ': ' + esc(l.void_reason) : ''}</small>`
      : l.sent === 'pending' ? ' <small class="sent-tag" style="opacity:.7">🕒 pending</small>'
      : (l.sent ? ' <small class="sent-tag">sent</small>' : '');
    const controls = l.voided ? ''
      : l.sent === 'pending' ? ''
      : l.sent ? `<button data-action="void-line" data-id="${i}" style="color:var(--red)">Void</button>`
      : `<div class="qty"><button data-action="cart-qty" data-id="${i}" data-delta="-1">−</button><button data-action="cart-qty" data-id="${i}" data-delta="1">+</button><button data-action="cart-del" data-id="${i}" style="color:var(--red)">✕</button></div>`;
    const seatBadge = l.seat != null ? `<br><small style="color:var(--warm-gray)">Seat ${esc(String(l.seat))}</small>` : '';
    const seatInput = (l.voided || l.sent) ? '' :
      `<input type="number" min="1" placeholder="Seat" value="${l.seat ?? ''}" data-action="set-seat" data-id="${i}"
        style="width:56px;color:var(--charcoal);margin-top:6px;font-size:12px;padding:4px 6px">`;
    return `<div class="cart-line"${l.voided || l.sent === 'pending' ? ' style="opacity:.6"' : ''}>
      <div><b>${l.qty}×</b> ${esc(l.name)}${tag}${modStr ? `<br><small style="color:var(--warm-gray)">${esc(modStr)}</small>` : ''}${l.note ? `<br><small style="color:var(--terra)">📝 ${esc(l.note)}</small>` : ''}${seatBadge}${seatInput}</div>
      <div style="display:flex;align-items:center;gap:10px"><span${l.voided ? ' style="text-decoration:line-through"' : ''}>${fmt(lt)}</span>
        ${controls}
      </div></div>`;
  }).join('');

  // Subtotal/service charge/SST come straight from the live order's server-computed
  // bill (kept live-recomputed on every mutation) — never recomputed here. Lines
  // added but not yet sent to the kitchen have no server figures yet, so their raw
  // price is folded into subtotal/total only (not yet taxed/charged server-side).
  const bill = liveOrder && liveOrder.subtotal != null ? liveOrder : null;
  const subtotal = bill ? bill.subtotal + unsentSubtotal : rawTotal;
  const svc = bill ? bill.service_charge : 0;
  const tax = bill ? bill.tax : 0;
  const total = bill ? bill.grand_total + unsentSubtotal : rawTotal;

  $('cart-subtotal-rm').textContent = fmt(subtotal);
  $('cart-svc-row').style.display = svc ? '' : 'none';
  $('cart-svc-rm').textContent = fmt(svc);
  $('cart-tax-rm').textContent = fmt(tax);
  $('cart-total-rm').textContent = fmt(total);
}

function setSeat(idx, value) {
  if (state.cart[idx].sent) return;
  const n = parseInt(value);
  state.cart[idx].seat = n > 0 ? n : null;
}

async function voidLine(idx) {
  const line = state.cart[idx];
  if (!line || !line.sent || line.voided) return;
  // Voids require server confirmation and must fail loudly offline (phase 07)
  // — a mis-queued void is a cash discrepancy nobody could reconstruct later.
  if (!navigator.onLine) return toast('Cannot void a line while offline');
  const reason = prompt('Reason for voiding this line (3-200 characters):');
  if (reason === null) return;
  if (reason.trim().length < 3) return toast('Reason must be at least 3 characters');
  const orderId = $('pay-btn').dataset.orderId;
  try {
    await API.post(`/api/orders/${orderId}/items/${line.id}/void`, { reason: reason.trim() });
    toast('Line voided');
    checkOpenOrder();
    renderTables();
  } catch (e) { toast('Void failed: ' + e.message); }
}

/* ===== MODIFIER-GROUP MODAL =====
   Driven entirely by the item's attached groups (menu.modifier_group_ids) and
   each group's mode/min_select/max_select — nothing here is kandar-specific;
   `kandar` is display-only from phase 04 on. */
function modifierGroupsFor(it) {
  return (it.modifier_group_ids || [])
    .map(gid => state.menu.modifier_groups.find(g => g.id === gid))
    .filter(Boolean);
}

function openModifierModal(it) {
  state.modItem = it;
  $('mod-title').textContent = it.name + ' — ' + fmt(it.price);
  let html = '';
  modifierGroupsFor(it).forEach(g => {
    const opts = state.menu.modifier_options.filter(o => o.group_id === g.id);
    const inputType = g.mode === 'radio' ? 'radio' : 'checkbox';
    const label = g.min_select > 0 ? `Choose ${g.min_select === g.max_select ? g.min_select : `${g.min_select}-${g.max_select}`} ${esc(g.name)}` : esc(g.name);
    html += `<div style="font-size:12px;color:var(--warm-gray);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin:14px 0 8px">${label}</div>`;
    html += opts.map(o => `<div class="mod-opt"><input type="${inputType}" name="grp-${g.id}" data-group="${g.id}" value="${o.id}"><span style="flex:1">${esc(o.name)}</span>${o.price ? `<span style="color:var(--terra);font-weight:700">+${fmt(o.price)}</span>` : ''}</div>`).join('');
  });
  $('mod-body').innerHTML = html;
  $('mod-remark').value = '';

  const presets = ['Kurang pedas', 'No onion', 'Extra spicy', 'Kurang minyak', 'Banjir sikit'];
  $('mod-presets').innerHTML = presets.map(p =>
    `<button class="btn small outline" data-action="set-mod-remark" data-value="${esc(p)}">${esc(p)}</button>`
  ).join('');

  updateModifierValidity();
  $('modal-bg').classList.add('show');
}

function updateModifierValidity() {
  const btn = $('mod-confirm-btn');
  if (!state.modItem || !btn) return;
  const ok = modifierGroupsFor(state.modItem).every(g => {
    const count = document.querySelectorAll(`input[data-group="${g.id}"]:checked`).length;
    return count >= g.min_select && count <= g.max_select;
  });
  btn.disabled = !ok;
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
  const note = $('mod-remark').value.trim();
  state.cart.push({ item_id: state.modItem.id, name: state.modItem.name, price: state.modItem.price, qty: 1, mods, note });
  closeModal(); renderCart();
}

/* ===== SEND ORDER =====
   Writes through the outbox (phase 07): enqueue and return immediately — the
   waiter is never blocked on the network. Lines render as "pending" (see
   renderCart) until the outbox confirms the server has them; checkOpenOrder(),
   triggered on every outbox change, reconciles the cart to server truth once
   it does. A 409 race (another device already opened this table — phase 03)
   is handled inside the outbox itself: it converts the queued create into an
   append and retries once. */
async function sendOrder() {
  if (!state.selTable || !state.cart.length) return toast('Add items first');
  const toSend = state.cart.filter(l => !l.sent);
  if (!toSend.length) return toast('No new items to send');

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

  // liveOrder (kept fresh by checkOpenOrder — selectTable, realtime events,
  // and outbox reconciliation) tells us whether to create or append, without
  // depending on a fresh network round-trip that offline can't provide.
  const request = liveOrder && liveOrder.table_id === state.selTable.id
    ? { url: `/api/orders/${liveOrder.id}/items`, method: 'POST', body: { items } }
    : { url: '/api/orders', method: 'POST', body: { table_id: state.selTable.id, items } };

  await enqueue(request);
  toSend.forEach(l => { l.sent = 'pending'; });
  renderCart();
  toast(navigator.onLine ? 'Sending to kitchen…' : 'Offline — queued, will send when back online');
}

/* ===== PAYMENT =====
   Everything shown here (subtotal/tax/total/amount_due/payments-so-far) comes
   straight from the order, which the server keeps recomputed on every change
   (phase 05) — no client-side bill math to duplicate or get out of sync. */
let currentOrder = null;
// A split view the cashier is actively working through — {title, items:[{label,amount}]}.
// Computed once from the balance at split time; paying a share removes just that
// entry (never a fresh re-split of the shrinking remainder, which would silently
// change the numbers the cashier was just shown and told to collect).
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
  // Only ask once, when the modal is first opened — not on every refresh after a
  // partial payment, which would otherwise re-prompt on each split-payment leg.
  if (['sent', 'preparing'].includes(currentOrder.status)) {
    if (!confirm(`⚠️ Food is still ${currentOrder.status}. Are you sure you want to mark as paid?`)) return;
  }
  $('pay-modal').classList.add('show');
}

function renderPayModal() {
  const o = currentOrder;
  const rows = [`<div>Subtotal <span style="float:right">${fmt(o.subtotal)}</span></div>`];
  if (o.service_charge) rows.push(`<div>Service charge <span style="float:right">${fmt(o.service_charge)}</span></div>`);
  rows.push(`<div>SST <span style="float:right">${fmt(o.tax)}</span></div>`);
  if (o.discount) rows.push(`<div>Discount <span style="float:right">-${fmt(o.discount)}</span></div>`);
  rows.push(`<div style="font-weight:700;margin-top:6px">Total <span style="float:right">${fmt(o.grand_total)}</span></div>`);

  if (o.discounts?.length) {
    rows.push(`<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--light-gray)"><b>Discounts applied</b></div>`);
    o.discounts.forEach(d => {
      const removeBtn = API.user.role === 'admin' && !o.payments?.length
        ? `<button data-action="remove-discount" data-id="${d.id}" style="color:var(--red)">Remove</button>` : '';
      rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <small>${esc(d.kind)} — ${esc(d.reason)}</small>
        <span style="display:flex;align-items:center;gap:8px"><small>-${fmt(d.amount)}</small>${removeBtn}</span></div>`);
    });
  }

  if (o.payments?.length) {
    rows.push(`<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--light-gray)"><b>Paid so far</b></div>`);
    o.payments.forEach(p => rows.push(`<div><small>${esc(p.method)}</small> <span style="float:right"><small>${fmt(p.amount)}</small></span></div>`));
    // Reprints are a known fraud vector — admin only, and the server always
    // audits one (phase 08).
    if (API.user.role === 'admin') {
      rows.push(`<div style="margin-top:8px"><button class="btn small outline" data-action="reprint-receipt">Reprint receipt</button></div>`);
    }
  }
  rows.push(`<div style="font-weight:700;color:var(--terra);margin-top:6px">Remaining <span style="float:right">${fmt(o.amount_due)}</span></div>`);

  $('pay-details').innerHTML = `<div style="font-size:14px;color:var(--warm-gray);margin-bottom:8px">Order #${o.id}</div>${rows.join('')}`;
  $('pay-amount-input').value = '';
  $('cash-received-input').value = '';
  $('pay-change-due').textContent = '';
  $('pay-cash-row').style.display = '';
  $('pay-amount-row').style.display = '';
  closeDiscountForm();
  renderSplitResult();
}

function renderSplitResult() {
  if (!pendingShares || !pendingShares.items.length) { $('pay-split-result').innerHTML = ''; return; }
  $('pay-split-result').innerHTML = `<div style="margin-top:10px"><b>${esc(pendingShares.title)}</b></div>` +
    pendingShares.items.map((s, i) => `
      <div class="cart-line"><div>${esc(s.label)}: ${fmt(s.amount)}</div>
        <div style="display:flex;gap:6px">
          <button class="btn small" data-action="pay-share" data-idx="${i}">Pay cash</button>
          <button class="btn small sage" data-action="pay-share" data-idx="${i}" data-method="Card">Pay card</button>
        </div></div>`).join('');
}

function closePayModal() { $('pay-modal').classList.remove('show'); currentOrder = null; pendingShares = null; }

function updateChangeDue() {
  if (!currentOrder) return;
  const amount = Number($('pay-amount-input').value || currentOrder.amount_due);
  const receivedCents = Math.round(Number($('cash-received-input').value || 0) * 100);
  const changeCents = receivedCents - Math.round(amount * 100);
  $('pay-change-due').textContent = receivedCents ? `Change due: ${fmt(Math.max(0, changeCents) / 100)}` : '';
  $('pay-change-due').style.color = changeCents < 0 ? 'var(--red)' : 'var(--charcoal)';
}

/* method === null pays the full remaining balance; otherwise `amount`/`tendered`
   (RM) pay exactly that much — used for split-by-amount and split-by-seat. */
async function processPay(method, amount, tendered) {
  // Payments require server confirmation and must fail loudly offline (phase
  // 07) — unlike order entry, they are never queued: a mis-queued payment is
  // a cash discrepancy nobody can reconstruct.
  if (!navigator.onLine) return toast('Cannot take payment while offline');
  const orderId = $('pay-btn').dataset.orderId;
  try {
    const body = { method };
    if (amount != null) body.amount = amount;
    if (method === 'Cash' && tendered != null) body.tendered = tendered;
    const r = await API.post(`/api/orders/${orderId}/pay`, body);
    if (r.settled) {
      closePayModal();
      state.cart = []; renderCart();
      $('pay-btn').style.display = 'none';
      toast(r.change > 0 ? `Paid in full — change ${fmt(r.change)}` : 'Paid in full');
      renderTables();
    } else {
      toast(`Paid ${fmt(r.paid)} — ${fmt(r.remaining)} remaining`);
      await refreshPayModal(); // update the modal with the new remaining balance, no re-prompt
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
  if (amount > currentOrder.amount_due + 0.001) return toast('Amount is more than what is remaining');
  // tendered is left unset (not forced equal to amount): cash can't physically be
  // tendered in exact sen the way a typed amount can, so when this leg settles the
  // order the server rounds to the nearest 5 sen and treats it as exact — forcing
  // tendered=amount here would instead reject a leg that needs rounding up.
  return processPay(method, amount, null);
}

// Pay off one previously-computed split share; the leg amount is fixed at split
// time, so this never re-derives it from the (now smaller) remaining balance.
async function paySplitShare(idx, method) {
  const share = pendingShares?.items[idx];
  if (!share) return;
  if (!navigator.onLine) return toast('Cannot take payment while offline');
  const orderId = $('pay-btn').dataset.orderId;
  try {
    // Same reasoning as payAmount: no forced tendered for Cash — a split share
    // like RM3.33 isn't payable in exact coins, so let the server round the final
    // leg to the nearest 5 sen automatically instead of rejecting the payment.
    const body = { method, amount: share.amount };
    const r = await API.post(`/api/orders/${orderId}/pay`, body);
    pendingShares.items.splice(idx, 1);
    if (r.settled) {
      closePayModal();
      state.cart = []; renderCart();
      $('pay-btn').style.display = 'none';
      toast('Paid in full');
      renderTables();
    } else {
      toast(`Paid ${fmt(r.paid)} — ${fmt(r.remaining)} remaining`);
      await refreshPayModal();
    }
  } catch (e) { toast('Payment failed: ' + e.message); }
}

async function splitEvenlyUI() {
  const ways = parseInt(prompt('Split the remaining balance evenly — how many ways?', '2'));
  if (!ways || ways < 1) return;
  const orderId = $('pay-btn').dataset.orderId;
  try {
    const { shares } = await API.get(`/api/orders/${orderId}/split?ways=${ways}`);
    pendingShares = { title: `${ways}-way split`, items: shares.map((amt, i) => ({ label: `Share ${i + 1}`, amount: amt })) };
    renderSplitResult();
  } catch (e) { toast(e.message); }
}

async function splitBySeatUI() {
  const orderId = $('pay-btn').dataset.orderId;
  try {
    const { seats } = await API.get(`/api/orders/${orderId}/split?by=seat`);
    const entries = Object.entries(seats);
    if (!entries.length) return toast('No lines have a seat assigned');
    pendingShares = { title: 'By seat', items: entries.map(([seat, amt]) => ({ label: `Seat ${seat}`, amount: amt })) };
    renderSplitResult();
  } catch (e) { toast(e.message); }
}

/* ===== DISCOUNT ===== *
   Staff need an admin's PIN (phase 05's authorize-token flow); admin applies
   directly. Every path already writes its own audit row server-side. */
function openDiscountForm() {
  $('discount-form').style.display = '';
  $('discount-kind').value = 'percent';
  $('discount-value').value = '';
  $('discount-reason').value = '';
  $('discount-admin-name').value = '';
  $('discount-admin-pin').value = '';
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

  const orderId = $('pay-btn').dataset.orderId;
  const body = { kind, value, reason };

  try {
    if (API.user.role !== 'admin') {
      const name = $('discount-admin-name').value.trim();
      const pin = $('discount-admin-pin').value.trim();
      if (!name || !pin) return toast('Admin name and PIN are required to authorize a discount');
      const auth = await API.post('/api/discounts/authorize', { name, pin });
      body.authorize_token = auth.token;
    }
    await API.post(`/api/orders/${orderId}/discounts`, body);
    toast('Discount applied');
    await refreshPayModal();
  } catch (e) { toast('Discount failed: ' + e.message); }
}

async function removeDiscount(id) {
  const orderId = $('pay-btn').dataset.orderId;
  try {
    await API.del(`/api/orders/${orderId}/discounts/${id}`);
    toast('Discount removed');
    await refreshPayModal();
  } catch (e) { toast('Remove failed: ' + e.message); }
}

async function reprintReceipt() {
  const orderId = $('pay-btn').dataset.orderId;
  if (!confirm('Reprint this receipt? This is logged.')) return;
  try {
    await API.post(`/api/orders/${orderId}/reprint-receipt`, {});
    toast('Receipt reprint queued');
  } catch (e) { toast('Reprint failed: ' + e.message); }
}

/* ===== EVENT WIRING ===== */
$('tab-pos').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'select-table') selectTable(Number(el.dataset.id));
  else if (action === 'back-to-tables') backToTables();
  else if (action === 'set-cat') { state.activeCat = Number(el.dataset.id); renderMenu(); }
  else if (action === 'add-item') addItem(Number(el.dataset.id));
  else if (action === 'cart-qty') cartQty(Number(el.dataset.id), Number(el.dataset.delta));
  else if (action === 'cart-del') cartDel(Number(el.dataset.id));
  else if (action === 'void-line') voidLine(Number(el.dataset.id));
  else if (action === 'send-order') sendOrder();
  else if (action === 'open-pay') openPayModal();
});

$('tab-pos').addEventListener('change', e => {
  if (e.target.matches('input[data-action="set-seat"]')) setSeat(Number(e.target.dataset.id), e.target.value);
});

$('item-search').addEventListener('input', e => setSearch(e.target.value));

$('modal-bg').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) {
    const action = el.dataset.action;
    if (action === 'set-mod-remark') $('mod-remark').value = el.dataset.value;
    else if (action === 'close-mod-modal') closeModal();
    else if (action === 'confirm-mods') confirmModifiers();
    return;
  }
  if (e.target === $('modal-bg')) closeModal();
});

$('modal-bg').addEventListener('change', e => {
  if (e.target.matches('input[data-group]')) updateModifierValidity();
});

$('pay-modal').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) {
    const action = el.dataset.action;
    if (action === 'pay') payFull(el.dataset.method);
    else if (action === 'pay-amount') payAmount(el.dataset.method || 'Cash');
    else if (action === 'pay-share') paySplitShare(Number(el.dataset.idx), el.dataset.method || 'Cash');
    else if (action === 'split-evenly') splitEvenlyUI();
    else if (action === 'split-by-seat') splitBySeatUI();
    else if (action === 'open-discount-form') openDiscountForm();
    else if (action === 'close-discount-form') closeDiscountForm();
    else if (action === 'apply-discount') applyDiscount();
    else if (action === 'remove-discount') removeDiscount(Number(el.dataset.id));
    else if (action === 'reprint-receipt') reprintReceipt();
    else if (action === 'close-pay-modal') closePayModal();
    return;
  }
  if (e.target === $('pay-modal')) closePayModal();
});

$('pay-modal').addEventListener('change', e => {
  if (e.target.id === 'discount-kind') updateDiscountValueUI();
});

$('cash-received-input').addEventListener('input', updateChangeDue);

$('remark-modal').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) {
    const action = el.dataset.action;
    if (action === 'set-remark') $('remark-input').value = el.dataset.value;
    else if (action === 'skip-remark') skipRemark();
    else if (action === 'confirm-remark') confirmRemark();
    return;
  }
  if (e.target === $('remark-modal')) closeRemarkModal();
});

/* Realtime: a change on any table's order should update the table grid live, or —
   if this device is sitting inside that table's workspace — its cart/pay button. */
onStreamEvent(() => {
  if (!document.getElementById('tab-pos')?.classList.contains('active')) return;
  if (!state.selTable) renderTables();
  else checkOpenOrder();
});

/* ===== OFFLINE (phase 07) =====
   The outbox flushing reconciles "pending" cart lines back to server truth;
   the banner only names the offline case explicitly (a queue that is simply
   still draining while online needs no persistent warning). */
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
