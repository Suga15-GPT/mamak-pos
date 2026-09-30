import { state, $, fmt, esc, toast, onStreamEvent, stateWords, minsSince, ask } from './state.js';
import { enqueue, pending as outboxPending, failedEntries, dismissFailed, onOutboxChange, resultFor } from './outbox.js';
import { on, fill } from './features.js';
import { t } from './i18n.js';

/* ===== DATA LOADING ===== */
export async function loadAll() {
  try {
    [state.menu, state.cards] = await Promise.all([API.get('/api/menu'), API.get('/api/cards')]);
    state.activeCat = state.menu.categories[0]?.id;
    renderTables();
    renderMenu();
    renderFavs();
  } catch (e) { toast('Failed to load data: ' + e.message); }
}

/* ===== THE FLOOR =====
   Card mode: the floor is a grid of numbered customer cards, 1..N. A card's
   state is read off its order's rounds, not off one global kitchen
   status: a card can hold round 1 served and round 2 cooking at the same
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
    <span class="t-sub">${mins} min · ${items} item${items === 1 ? '' : 's'}${stale ? ' · check this card' : ''}</span>
    ${pending ? `<span class="t-sub">⏳ ${pending} waiting for you</span>` : ''}
    ${order.bill_group_id ? '<span class="t-sub">🔗 Combined bill</span>' : ''}
    ${(order.merged_from || []).length ? `<span class="t-sub">🔗 ${esc(fill(t('merge.tileWith'), { cards: order.merged_from.map(m => m.card_number).join(', ') }))}</span>` : ''}
    <span class="t-total">${fmt(total)}</span>
  </button>`;
}

/* Coming back to the floor tab while a card's bill is open should return to
   that bill, not throw the waiter back to the grid mid-order — but it must
   re-read the order first, because the kitchen may have moved it on while they
   were away. */
export function refreshPos() {
  if (state.selTable) return checkOpenOrder();
  return renderTables();
}

export async function renderTables() {
  let orders = [];
  try {
    // The card list is re-read too: an admin may have changed how many there are.
    [orders, state.cards] = await Promise.all([API.get('/api/orders'), API.get('/api/cards')]);
  } catch (e) { /* offline: render what we have */ }

  // GET /api/orders (no mode=) already excludes paid/cancelled/refunded, and the
  // DB enforces at most one open order per card, so this is unambiguous.
  const byCard = {};
  orders.forEach(o => { if (o.card_id) byCard[o.card_id] = o; });

  $('tables-grid').innerHTML = state.cards
    .map(c => tileHtml({ key: `cd-${c.number}`, name: `Card ${c.number}`, order: byCard[c.id], action: 'select-table', id: c.id }))
    .join('') || '<div class="empty">No cards set up yet — set how many in Admin → Cards &amp; QR.</div>';

  // Table orders still open from before card mode stay visible and payable
  // until they close; there is nothing to start on a table any more.
  const legacy = orders.filter(o => o.order_type === 'dine_in' && !o.card_id);
  $('legacy-section').hidden = !legacy.length;
  $('legacy-grid').innerHTML = legacy
    .map(o => tileHtml({ key: `lg-${o.id}`, name: o.label, order: o, action: 'select-legacy', id: o.id }))
    .join('');

  // Takeaway is its own section, not a tile pretending to be a table.
  const takeaway = orders.filter(o => o.order_type === 'takeaway');
  $('takeaway-grid').innerHTML = takeaway
    .map(o => tileHtml({ key: `ta-${o.id}`, name: o.label, order: o, action: 'select-takeaway', id: o.id }))
    .join('') || '<div class="empty" style="grid-column:1/-1">No takeaway orders right now.</div>';

  // A one-line read of the floor, above the grid: how many cards are running
  // and how many are sitting there waiting to be collected from.
  const open = Object.keys(byCard).length;
  const toPay = Object.values(byCard).filter(o => o.status === 'served').length;
  const summary = $('floor-summary');
  if (summary) {
    summary.textContent = open
      ? `${open} card${open === 1 ? '' : 's'} in use` + (toPay ? ` · ${toPay} ready to pay` : '')
      : 'Every card is free.';
  }
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
  $('bill-where').textContent = sel.name;
  $('bill-kind').textContent = sel.type === 'takeaway' ? 'Takeaway' : 'Dine in';
  $('bill-badge').innerHTML = '';
  $('move-order-btn').style.display = 'none';
  $('combine-btn').style.display = 'none';
  // Until this card's own bill is looked up, Take Payment must not open the
  // previous card's bill (review follow-up: the button kept the last order id).
  $('pay-btn').style.display = 'none';
  delete $('pay-btn').dataset.orderId;
  $('bill-group').innerHTML = '';
  renderCart();
  renderMenu();
  renderFavs();
  checkOpenOrder();
}

// A free card starts an order; an in-use card opens its bill.
function selectTable(id) {
  const c = state.cards.find(x => x.id === id);
  openWorkspace({ type: 'dine_in', cardId: id, name: c ? `Card ${c.number}` : '', orderId: null });
}

// A table order from before card mode, found by its order id.
function selectLegacy(orderId) {
  openWorkspace({ type: 'dine_in', cardId: null, name: '', orderId });
}

function selectTakeaway(orderId) {
  openWorkspace({ type: 'takeaway', cardId: null, name: `Takeaway #${orderId}`, orderId });
}

function newTakeaway() {
  openWorkspace({ type: 'takeaway', cardId: null, name: 'New takeaway', orderId: null });
}

function backToTables() {
  $('pos-mobile-bar').hidden = true;
  $('pos-workspace').style.display = 'none';
  $('pos-tables').style.display = '';
  state.selTable = null;
  state.cart = [];
  liveOrder = null;
  renderTables();
}

async function checkOpenOrder() {
  if (!state.selTable) return;
  // A brand-new takeaway ticket has no card to look itself up by, so it learns
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
    const open = sel.cardId
      ? orders.find(o => o.card_id === sel.cardId)
      : orders.find(o => o.id === sel.orderId);

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
      if (!sel.cardId) {
        state.selTable.name = open.label;
        $('ws-title').textContent = open.label;
        $('bill-where').textContent = open.label;
      }
      state.cart = open.items.map(l => ({
        id: l.id, item_id: l.item_id || 0, name: l.name, price: l.price, qty: l.qty, mods: l.mods,
        note: l.note || '', sent: true, voided: l.voided, void_reason: l.void_reason,
        round: l.round, round_no: l.round_no, from_card: l.from_card,
        round_status: l.round_status, station: l.station, send_id: l.send_id, held: l.held,
      })).concat(unsent);
      $('pay-btn').style.display = '';
      $('pay-btn').dataset.orderId = open.id;
      $('pay-btn').dataset.orderStatus = open.status;
      $('move-order-btn').style.display = '';
      // Combine takes another card's bill onto this one; a card still on a
      // combined bill from before merge shipped is paid with that bill.
      $('combine-btn').style.display = open.card_id && !open.bill_group_id ? '' : 'none';
      renderBillGroup(open, orders);
      const w = stateWords(open.status);
      $('bill-badge').innerHTML = `<span class="badge ${esc(open.status)}">${w.icon} ${esc(w.label)}</span>`;
    } else {
      liveOrder = null;
      state.cart = unsent;
      $('pay-btn').style.display = 'none';
      $('move-order-btn').style.display = 'none';
      $('combine-btn').style.display = 'none';
      $('bill-group').innerHTML = '';
      $('bill-badge').innerHTML = '';
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

/* No photograph exists for a menu item — this restaurant types its menu, it does
   not shoot it — so the card carries a monogram tile built from the item's own
   name instead. Four token tints, chosen deterministically, so the grid reads as
   a grid and the same dish always looks the same. */
function monogram(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { letters, tint: 't' + (h % 4) };
}

function itemButton(it, extraClass = '') {
  const station = state.menu.stations?.find(s => s.code === it.station_code);
  const m = monogram(it.name);
  const asks = (it.modifier_group_ids || []).length;
  return `<button class="item-btn ${extraClass}" data-action="add-item" data-id="${it.id}"
      aria-label="Add ${esc(it.name)}, ${fmt(it.price)}">
    <span class="top">
      <span class="thumb ${m.tint}" aria-hidden="true">${esc(m.letters)}</span>
      <span class="plus" aria-hidden="true">+</span>
    </span>
    <span class="nm">${esc(it.name)}</span>
    ${station && station.code !== 'kitchen' ? `<span class="st">${esc(station.name)}</span>` : ''}
    ${asks ? '<span class="mod-hint">Has choices</span>' : ''}
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

/* A bill line is three rows, not one: what it is and what it costs, then what
   was asked for, then the controls. Squeezing a stepper and a note button onto
   the same row as the name turned every dish into wrapped lines on the panel
   width a tablet actually has. */
function lineHtml(l, i) {
  const lt = (l.price + l.mods.reduce((s, m) => s + m.price, 0)) * l.qty;
  const modStr = l.mods.map(m => m.name + (m.price ? ` +${fmt(m.price)}` : '')).join(', ');
  const sub = [modStr, l.note ? `📝 ${l.note}` : '']
    .filter(Boolean).map(esc).join(' · ');

  let actions = '';
  if (l.voided) actions = '';
  // A customer's QR round waiting for staff approval: shown, but not on the
  // bill — it counts in no total until someone accepts it.
  else if (l.held) actions = '<span class="round-tag pending">⏳ Awaiting approval</span>';
  else if (l.sent === 'pending') actions = '<span class="round-tag pending">⏳ Sending…</span>';
  else if (l.sent) actions = `<button data-action="void-line" data-id="${i}">❌ Void</button>`;
  else actions = `<div class="qty">
      <button data-action="cart-qty" data-id="${i}" data-delta="-1" aria-label="One fewer">−</button>
      <button data-action="cart-qty" data-id="${i}" data-delta="1" aria-label="One more">+</button>
    </div>
    <button class="ln-btn" data-action="open-note" data-id="${i}" aria-label="Add a remark for ${esc(l.name)}">📝</button>
    <button class="ln-btn del" data-action="cart-del" data-id="${i}" aria-label="Remove ${esc(l.name)}">✕</button>`;

  const cls = ['bill-line'];
  if (l.sent !== true) cls.push('is-new');
  if (l.voided || l.held || l.sent === 'pending') cls.push('is-muted');

  return `<div class="${cls.join(' ')}">
    <div class="bl-top">
      <span class="bl-name">${l.qty}× ${esc(l.name)}${l.voided ? ' <span class="round-tag voided">Voided</span>' : ''}</span>
      <span class="bl-price"${l.voided || l.held ? ' style="text-decoration:line-through"' : ''}>${fmt(lt)}</span>
    </div>
    ${sub ? `<div class="bl-sub">${sub}</div>` : ''}
    ${l.voided && l.void_reason ? `<div class="bl-sub">${esc(l.void_reason)}</div>` : ''}
    ${actions ? `<div class="bl-actions">${actions}</div>` : ''}
  </div>`;
}

/* "Round 2", or for a round Combine brought over from another card, the name
   its kitchen ticket carries too: "Round 1 · Card 1 (from 4)". Card labels are
   the same words in either language, so a bill and its ticket always match. */
function roundName(l, fallback) {
  const n = `Round ${l.round_no ?? fallback}`;
  if (l.from_card == null) return n;
  return `${n} · ${liveOrder?.label || state.selTable?.name || ''} (from ${l.from_card})`;
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
      const sentQty = sentLines.filter(([l]) => !l.voided).reduce((s2, [l]) => s2 + l.qty, 0);
      html += `<div class="bill-group-head"><span>✅ Already sent</span><span>${sentQty} item${sentQty === 1 ? '' : 's'}</span></div>`;
      [...rounds.keys()].sort((a, b) => a - b).forEach(round => {
        const lines = rounds.get(round);
        const st = lines.find(([l]) => l.round_status)?.[0].round_status;
        const w = stateWords(st || 'sent');
        html += `<div class="bill-round-head">
            <span>${esc(roundName(lines[0][0], round))}</span><span class="round-tag ${esc(st || '')}">${w.icon} ${esc(w.label)}</span></div>`;
        html += lines.map(([l, i]) => lineHtml(l, i)).join('');
      });
    }

    if (newLines.length) {
      const newQty = newLines.reduce((s2, [l]) => s2 + l.qty, 0);
      html += `<div class="bill-group-head new"><span>🆕 New — not sent yet</span><span>${newQty} item${newQty === 1 ? '' : 's'}</span></div>`;
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
    if (l.voided || l.held) return;
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
    ? (on('kitchen') ? '🍳 <span>Send to Kitchen</span>' : `🧾 <span>${t('pos.sendOrder')}</span>`)
    : `🍳 <span>Send ${count} new item${count === 1 ? '' : 's'}</span>`;

  renderTimeline();
  renderMobileBar(count, bill ? bill.grand_total + unsentSubtotal : rawTotal);
}

/* The same two facts the bill panel shows, following the thumb on a phone: what
   is going to the kitchen, and what the table owes. Hidden on a wide screen,
   where the bill panel is already on the right of the menu. */
function renderMobileBar(newCount, total) {
  const bar = $('pos-mobile-bar');
  if (!bar) return;
  const visible = !!state.selTable && state.cart.length > 0;
  bar.hidden = !visible;
  if (!visible) return;
  $('mb-count').textContent = newCount
    ? `${newCount} new item${newCount === 1 ? '' : 's'} to send`
    : 'Nothing new to send';
  $('mb-total').textContent = fmt(total);
  const send = $('mb-send');
  send.disabled = newCount === 0;
  send.textContent = newCount ? `🍳 Send ${newCount}` : '🍳 Send';
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
    const from = s.merged_from_card_number != null ? ` · from Card ${s.merged_from_card_number}` : '';
    return `<div class="cart-line"><div>
        <div class="line-name">Round ${s.round_no ?? s.seq_no}${esc(from)} · ${esc(time)}</div>
        <div class="line-sub">${count} item${count === 1 ? '' : 's'} · by ${esc(s.source === 'qr' ? 'Customer QR' : (s.sent_by_name || 'staff'))}</div>
      </div><div class="line-right">${states}</div></div>`;
  }).join('');
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
      : { url: '/api/orders', method: 'POST', body: { card_id: sel.cardId, items } };
  if (!liveOrder && sel.type === 'dine_in' && !sel.cardId) return toast('This table order is closed — start a new one on a card');
  request.meta = { label: sel.name || '', lines: toSend.map(l => `${l.qty}× ${l.name}`) };

  // Marked before anything is awaited: a second Send fired in the same
  // instant then finds nothing new to send, instead of queueing these lines
  // a second time (review P4).
  toSend.forEach(l => { l.sent = 'pending'; });
  let entry;
  try {
    entry = await enqueue(request);
  } catch (e) {
    toSend.forEach(l => { l.sent = false; });
    renderCart();
    return toast('Could not queue the order: ' + e.message);
  }
  if (!liveOrder) pendingCreateEntry = entry.id;
  toSend.forEach(l => { l.entry = entry.id; });
  renderCart();
  toast(navigator.onLine ? 'Sending to kitchen…' : 'Offline — queued, will send when back online');
}

/* ===== MOVE ORDER =====
   A lost or swapped card: the whole bill moves onto a free card. */
async function openMove() {
  if (!liveOrder) return;
  const cards = await API.get('/api/cards').catch(() => state.cards);
  const options = cards.filter(c => !c.in_use);
  $('move-target').innerHTML = options.length
    ? options.map(c => `<option value="${c.id}">Card ${c.number}</option>`).join('')
    : '<option value="">No free card</option>';
  $('move-err').textContent = '';
  $('move-modal').classList.add('show');
}
function closeMove() { $('move-modal').classList.remove('show'); }
async function confirmMove() {
  const cardId = Number($('move-target').value);
  if (!cardId) return;
  try {
    const r = await API.post(`/api/orders/${liveOrder.id}/move`, { card_id: cardId });
    closeMove();
    toast(`Moved to ${r.label}`);
    state.selTable = { type: 'dine_in', cardId, name: r.label, orderId: liveOrder.id };
    $('ws-title').textContent = r.label;
    $('bill-where').textContent = r.label;
    checkOpenOrder();
  } catch (e) { $('move-err').textContent = e.message; }
}

/* ===== COMBINE =====
   On Card 1, Combine -> Card 4: Card 4's items, rounds and kitchen tickets
   move onto Card 1's bill there and then, and Card 4 is free for the next
   group. "Separate Card 4" puts exactly those items back on Card 4 while
   nothing has been paid and Card 4 is still free.

   A combined bill from before this (cards that kept their own orders and
   paid together) still shows here, is paid in one go, and a card can still
   be taken out of it — but the till no longer makes new ones. */
function renderBillGroup(open, orders) {
  let html = '';
  if (open.bill_group_id) {
    const members = orders.filter(o => o.bill_group_id === open.bill_group_id)
      .sort((a, b) => a.card_number - b.card_number);
    html += `<div class="bill-group-note">🔗 Combined bill: ${members.map(m => esc(m.label)).join(', ')}
      <button class="btn small ghost" data-action="leave-group">Take this card out</button></div>`;
  }
  (open.merged_from || []).forEach(m => {
    html += `<div class="bill-group-note" data-feature="split_combine">🔗 ${esc(fill(t('merge.note'), { from: m.card_number }))}
      <button class="btn small ghost" data-action="separate-card" data-id="${m.card_id}"
        data-number="${m.card_number}">${esc(fill(t('merge.separate'), { from: m.card_number }))}</button></div>`;
  });
  $('bill-group').innerHTML = html;
}

async function openCombine() {
  if (!liveOrder) return;
  const orders = await API.get('/api/orders').catch(() => []);
  // Another card's open bill, not on a combined bill from before.
  const others = orders
    .filter(o => o.card_id && o.id !== liveOrder.id && !o.bill_group_id)
    .sort((a, b) => a.card_number - b.card_number);
  $('combine-title').textContent = fill(t('merge.title'), { card: liveOrder.label });
  $('combine-list').innerHTML = others.length
    ? others.map(o => `<label class="combine-option"><input type="radio" name="combine-from" value="${o.id}" data-label="${esc(o.label)}">
        <span>${esc(o.label)}</span><span>${fmt(o.grand_total ?? o.total)}</span></label>`).join('')
    : `<div class="empty">${esc(t('merge.none'))}</div>`;
  $('combine-err').textContent = '';
  $('combine-modal').classList.add('show');
}
function closeCombine() { $('combine-modal').classList.remove('show'); }
async function confirmCombine() {
  const picked = $('combine-list').querySelector('input:checked');
  if (!picked) { $('combine-err').textContent = t('merge.pick'); return; }
  try {
    const r = await API.post(`/api/orders/${liveOrder.id}/merge`, { from_order_id: Number(picked.value) });
    closeCombine();
    toast(fill(t('merge.done'), { from: r.from_label, card: r.label }));
    checkOpenOrder();
  } catch (e) { $('combine-err').textContent = e.message; }
}

async function separateCard(cardId, number) {
  if (!liveOrder) return;
  try {
    await API.post(`/api/orders/${liveOrder.id}/separate`, { card_id: cardId });
    toast(fill(t('merge.separated'), { from: number }));
    checkOpenOrder();
  } catch (e) { toast(e.message); }
}

async function leaveGroup() {
  if (!liveOrder?.bill_group_id) return;
  try {
    await API.del(`/api/bill-groups/${liveOrder.bill_group_id}/orders/${liveOrder.id}`);
    toast(`${liveOrder.label} is on its own bill again`);
    checkOpenOrder();
  } catch (e) { toast(e.message); }
}

/* ===== PAYMENT =====
   Everything shown here (subtotal/tax/total/amount_due/payments-so-far) comes
   straight from the order, which the server keeps recomputed on every change —
   no client-side bill math to duplicate or get out of sync. */
let currentOrder = null;
// Set while the modal is taking payment for a combined bill: currentOrder is
// then the group (GET /api/bill-groups/:id), which carries the same
// amount_due/total fields the single-order flow reads.
let currentGroupId = null;
// A split view the cashier is actively working through. Computed once from the
// balance at split time; paying a share removes just that entry, never a fresh
// re-split of the shrinking remainder.
let pendingShares = null;
// "Split by items" while it is open: the ticked lines, and what the server
// says they come to (GET .../split?by=items). The till never works out tax.
let itemSplit = null;
let itemPreviewSeq = 0;
// "Pay part of the bill" starts folded away each time the panel opens.
let payPartOpen = false;

async function refreshPayModal() {
  const orderId = $('pay-btn').dataset.orderId;
  if (!orderId) return false;
  const orders = await API.get('/api/orders').catch(() => []);
  const order = orders.find(o => o.id == orderId);
  if (!order) return false;
  if (order.bill_group_id) {
    const group = await API.get(`/api/bill-groups/${order.bill_group_id}`).catch(() => null);
    if (!group) return false;
    currentGroupId = group.id;
    // For the "still being prepared?" check: the most urgent member decides.
    group.status = group.members.some(m => ['sent', 'preparing'].includes(m.status)) ? 'preparing' : 'served';
    currentOrder = group;
  } else {
    currentGroupId = null;
    currentOrder = order;
  }
  renderPayModal();
  return true;
}

async function openPayModal() {
  pendingShares = null;
  itemSplit = null;
  payPartOpen = false;
  if (!(await refreshPayModal())) return toast('Order not found');
  // Only ask once, when the modal is first opened — not on every refresh after
  // a partial payment, which would re-prompt on each split-payment leg.
  if (['sent', 'preparing'].includes(currentOrder.status)) {
    if (!confirm('Food is still being prepared. Take payment anyway?')) return;
  }
  $('pay-modal').classList.add('show');
}

// A combined bill: each card's lines under its own "Card N" heading, the money
// summed across the cards (each card's tax is its own), one total.
function renderGroupPayModal() {
  const g = currentOrder;
  const rows = g.members.map(m => `<div class="bill-group-head">${esc(m.label)}</div>` +
    m.items.filter(i => !i.voided).map(i => {
      const unit = i.price + i.mods.reduce((t, x) => t + x.price, 0);
      // A held line is shown, but is not on the bill and has no price yet.
      return `<div class="cart-line"><div class="line-sub">${i.qty}× ${esc(i.name)}</div>
        <div class="line-right">${i.held ? '⏳ Awaiting approval' : fmt(Math.round(unit * i.qty * 100) / 100)}</div></div>`;
    }).join(''));
  if (g.awaiting_approval) {
    rows.unshift('<div class="banner warn" style="margin-bottom:8px">A customer order is waiting for approval — approve or reject it first.</div>');
  }
  rows.push(`<div class="totals"><div class="row"><span>Subtotal</span><span>${fmt(g.subtotal)}</span></div>`);
  if (g.service_charge) rows.push(`<div class="row"><span>Service charge</span><span>${fmt(g.service_charge)}</span></div>`);
  rows.push(`<div class="row"><span>SST</span><span>${fmt(g.tax)}</span></div>`);
  if (g.discount) rows.push(`<div class="row"><span>Discount</span><span>-${fmt(g.discount)}</span></div>`);
  rows.push(`<div class="row grand"><span>Total</span><span>${fmt(g.total)}</span></div></div>`);
  if (g.paid) rows.push(`<div class="cart-line"><div class="line-sub">Paid so far</div><div class="line-right">${fmt(g.paid)}</div></div>`);
  rows.push(`<div class="totals"><div class="row grand"><span>To pay</span><span>${fmt(g.amount_due)}</span></div></div>`);
  $('pay-details').innerHTML = `<div class="meta" style="margin-bottom:8px">Combined bill #${g.id} · ${g.members.map(m => esc(m.label)).join(', ')}</div>${rows.join('')}`;
}

function renderPayModal() {
  // Discounts, refunds and splits are per card: they stay on a card's own
  // bill, and a combined bill is paid as one.
  $('pay-discount-section').style.display = currentGroupId ? 'none' : '';
  $('pay-split-section').style.display = currentGroupId ? 'none' : '';
  if (currentGroupId) {
    renderGroupPayModal();
    $('pay-amount-input').value = '';
    $('cash-received-input').value = '';
    $('pay-change-due').textContent = '';
    $('pay-cash-row').style.display = '';
    // A combined bill is paid in full in one go: no part-payment row; the
    // legs section takes a cash part plus the rest by card instead.
    $('pay-part').hidden = true;
    $('pay-group-legs').style.display = '';
    ['group-cash-part', 'group-cash-received'].forEach(id => { $(id).value = ''; });
    updateGroupLegsSummary();
    closeDiscountForm();
    closeRefundForm();
    $('refund-section').style.display = 'none';
    pendingShares = null;
    itemSplit = null;
    renderSplitResult();
    return;
  }
  $('pay-group-legs').style.display = 'none';
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
      rows.push('<div style="margin-top:8px" data-feature="printing"><button class="btn small outline" data-action="reprint-receipt">Reprint receipt</button></div>');
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
  $('pay-part').hidden = false;
  renderPayPart();
  closeDiscountForm();
  closeRefundForm();
  $('refund-section').style.display = (o.payments || []).some(p => p.refundable > 0.001) ? '' : 'none';
  renderSplitResult();
}

// "Pay part of the bill": a specific amount, folded away until asked for.
function renderPayPart() {
  $('pay-amount-row').hidden = !payPartOpen;
  $('pay-part-toggle').setAttribute('aria-expanded', String(payPartOpen));
  $('pay-part-toggle').querySelector('.chev').textContent = payPartOpen ? '▾' : '▸';
}
function togglePayPart() {
  payPartOpen = !payPartOpen;
  renderPayPart();
  if (payPartOpen) $('pay-amount-input').focus();
}

function renderSplitResult() {
  if (itemSplit) { renderItemSplit(); return; }
  if (!pendingShares || !pendingShares.items.length) { $('pay-split-result').innerHTML = ''; return; }
  $('pay-split-result').innerHTML = `<div class="bill-group-head">${esc(pendingShares.title)}</div>` +
    pendingShares.items.map((s, i) => `
      <div class="cart-line"><div class="line-name">${esc(s.label)}: ${fmt(s.amount)}</div>
        <div class="line-right">
          <button class="btn small" data-action="pay-share" data-idx="${i}">Pay cash</button>
          <button class="btn small info" data-action="pay-share" data-idx="${i}" data-method="Card">Pay card</button>
        </div></div>`).join('');
}

function closePayModal() { $('pay-modal').classList.remove('show'); currentOrder = null; currentGroupId = null; pendingShares = null; itemSplit = null; }

function updateChangeDue() {
  if (!currentOrder) return;
  const amount = Number($('pay-amount-input').value || currentOrder.amount_due);
  const receivedCents = Math.round(Number($('cash-received-input').value || 0) * 100);
  const changeCents = receivedCents - Math.round(amount * 100);
  $('pay-change-due').textContent = receivedCents ? `Change: ${fmt(Math.max(0, changeCents) / 100)}` : '';
  $('pay-change-due').style.color = changeCents < 0 ? 'var(--red)' : 'var(--charcoal)';
}

/* amount === null pays the full remaining balance; otherwise `amount`/`tendered`
   (RM) pay exactly that much — "Pay a specific amount". A pay-in-full also
   sends the "To pay" this screen shows, so a bill that grew on another till
   (a Combine, an add-on) is refused instead of charged unseen. */
let payBusy = false;
async function processPay(method, amount, tendered) {
  // Payments require server confirmation and must fail loudly offline — unlike
  // order entry, they are never queued: a mis-queued payment is a cash
  // discrepancy nobody can reconstruct.
  if (!navigator.onLine) return toast('Cannot take payment while offline');
  if (payBusy) return;
  payBusy = true;
  const orderId = $('pay-btn').dataset.orderId;
  try {
    const body = { method };
    if (amount != null) body.amount = amount;
    else body.expected_due = currentOrder.amount_due;
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
  } catch (e) {
    toast('Payment failed: ' + e.message);
    if (e.status === 409) await refreshPayOrClose();
  } finally { payBusy = false; }
}

// Re-reads the bill behind an open pay screen. A bill that closed or was
// combined into another card elsewhere closes the screen rather than leaving
// a stale total on it.
async function refreshPayOrClose() {
  if (await refreshPayModal()) return;
  closePayModal();
  toast('This bill was closed or combined on another till');
  if (state.selTable) checkOpenOrder();
}

// Called on a live update: repaint the pay screen only when what it would
// charge actually changed, so a cashier's typed amounts survive unrelated
// traffic. The server refuses a stale pay-in-full regardless (expected_due).
async function payModalLiveCheck() {
  if (payBusy || !currentOrder || !$('pay-modal').classList.contains('show')) return;
  const wasDue = currentOrder.amount_due;
  if (currentGroupId) {
    const g = await API.get(`/api/bill-groups/${currentGroupId}`).catch(() => null);
    if (g && g.amount_due === wasDue) return;
  } else {
    const orderId = $('pay-btn').dataset.orderId;
    const orders = await API.get('/api/orders').catch(() => null);
    if (!orders) return;
    const o = orders.find(x => x.id == orderId);
    if (o && !o.bill_group_id && o.amount_due === wasDue) return;
  }
  if (payBusy || !currentOrder) return;  // paying, or closed, while we were asking
  await refreshPayOrClose();
  if (currentOrder && currentOrder.amount_due !== wasDue) toast(`The bill changed on another till — it is now ${fmt(currentOrder.amount_due)}`);
}

/* ===== COMBINED BILL: every leg at once =====
   The server takes the legs together and refuses anything that would leave
   the bill open, so the screen only ever submits a whole payment. */
const roundCash = rm => Math.round(rm * 20) / 20;

function groupLegsFromForm() {
  const due = currentOrder.amount_due;
  const cashPart = roundCash(Number($('group-cash-part').value || 0));
  const received = Number($('group-cash-received').value || 0);
  const rest = Math.round((due - cashPart) * 100) / 100;
  return { due, cashPart, received, rest, method: $('group-rest-method').value };
}

function updateGroupLegsSummary() {
  if (!currentGroupId || !currentOrder) return;
  const f = groupLegsFromForm();
  if (!(f.cashPart > 0)) { $('group-legs-summary').textContent = ''; return; }
  if (f.rest < 0) { $('group-legs-summary').textContent = 'The cash part is more than the bill — use 💵 Cash instead.'; return; }
  const change = f.received ? Math.round((f.received - f.cashPart) * 100) / 100 : 0;
  $('group-legs-summary').textContent = `Cash ${fmt(f.cashPart)} + ${f.method === 'Card' ? 'card' : 'e-wallet'} ${fmt(f.rest)}`
    + (f.received ? (change >= 0 ? ` · change ${fmt(change)}` : ' · not enough cash received') : '');
}

async function payGroup(legs) {
  if (!navigator.onLine) return toast('Cannot take payment while offline');
  if (payBusy) return;
  payBusy = true;
  try {
    // The total this screen shows: a combined bill that grew since (an
    // add-on on one of its cards) is refused, not charged unseen (N3).
    const r = await API.post(`/api/bill-groups/${currentGroupId}/pay`, { legs, expected_due: currentOrder.amount_due });
    closePayModal();
    toast(r.change > 0 ? `Paid — change ${fmt(r.change)}` : 'Paid in full');
    backToTables();
  } catch (e) {
    toast('Payment failed: ' + e.message);
    if (e.status === 409) await refreshPayOrClose();
  } finally { payBusy = false; }
}

function payGroupLegs() {
  const f = groupLegsFromForm();
  if (!(f.cashPart > 0)) return toast('Enter the cash part');
  if (f.rest <= 0) return toast('The cash part covers the whole bill — use 💵 Cash instead');
  if (f.received && f.received < f.cashPart) return toast('Cash received is less than the cash part');
  const cash = { method: 'Cash', amount: f.cashPart };
  if (f.received) cash.tendered = f.received;
  return payGroup([{ method: f.method, amount: f.rest }, cash]);
}

async function payFull(method) {
  const tenderedInput = $('cash-received-input').value;
  if (currentGroupId) {
    if (method !== 'Cash') return payGroup([{ method, amount: currentOrder.amount_due }]);
    return payGroup([tenderedInput ? { method: 'Cash', tendered: Number(tenderedInput) } : { method: 'Cash' }]);
  }
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
  // One payment at a time: a double tap on a share recorded it twice (N1).
  if (payBusy) return;
  payBusy = true;
  try {
    const r = await API.post(`/api/orders/${$('pay-btn').dataset.orderId}/pay`, { method, amount: share.amount });
    pendingShares.items.splice(pendingShares.items.indexOf(share), 1);
    if (r.settled) { closePayModal(); toast('Paid in full'); backToTables(); }
    else { toast(`Paid ${fmt(r.paid)} — ${fmt(r.remaining)} left`); await refreshPayModal(); }
  } catch (e) { toast('Payment failed: ' + e.message); }
  finally { payBusy = false; }
}

async function splitEvenlyUI() {
  const ways = parseInt(await ask({ title: 'Split evenly', hint: 'How many people are sharing this bill?', value: '2', ok: 'Split' }));
  if (!ways || ways < 1) return;
  try {
    const { shares } = await API.get(`/api/orders/${$('pay-btn').dataset.orderId}/split?ways=${ways}`);
    itemSplit = null;
    pendingShares = { title: `${ways}-way split`, items: shares.map((amt, i) => ({ label: `Share ${i + 1}`, amount: amt })) };
    renderSplitResult();
  } catch (e) { toast(e.message); }
}

/* ===== SPLIT BY ITEMS =====
   Tick what one person had; they pay exactly those lines' share of the bill,
   service charge and tax included, as the server works it out. Lines already
   paid for are ticked off; the last share takes whatever is left, so the
   shares add up to the bill to the sen. Cash is rounded to 5 sen only on the
   payment that settles the bill, as always. */
const lineRM = i => (i.price + i.mods.reduce((s, m) => s + m.price, 0)) * i.qty;

function splitByItemsUI() {
  pendingShares = null;
  itemSplit = { selected: new Set(), preview: null, error: '' };
  renderSplitResult();
}

function renderItemSplit() {
  const o = currentOrder;
  const paid = new Set(o.paid_item_ids || []);
  const lines = (o.items || []).filter(i => !i.voided && !i.held);
  const rows = lines.map(i => {
    const isPaid = paid.has(i.id);
    const from = i.from_card != null ? ` <span class="meta">(from Card ${esc(String(i.from_card))})</span>` : '';
    return `<label class="split-item${isPaid ? ' paid' : ''}">
      <input type="checkbox" data-action="split-item" value="${i.id}" ${isPaid ? 'disabled checked' : ''}
        ${!isPaid && itemSplit.selected.has(i.id) ? 'checked' : ''}>
      <span class="si-name">${i.qty}× ${esc(i.name)}${from}</span>
      <span class="si-price">${isPaid ? esc(t('split.items.paid')) : fmt(lineRM(i))}</span>
    </label>`;
  }).join('');
  const ready = itemSplit.preview && itemSplit.selected.size;
  $('pay-split-result').innerHTML = `<div class="bill-group-head">${esc(t('split.byItems'))}</div>
    <p class="meta" style="margin-bottom:8px">${esc(t('split.items.hint'))}</p>
    <div class="split-items">${rows}</div>
    <div class="split-items-total" id="split-items-total" role="status">${itemSplitSummary()}</div>
    <div class="split-items-pay">
      <button class="btn small" data-action="pay-items" data-method="Cash" ${ready ? '' : 'disabled'}>${esc(t('split.items.payCash'))}</button>
      <button class="btn small info" data-action="pay-items" data-method="Card" ${ready ? '' : 'disabled'}>${esc(t('split.items.payCard'))}</button>
      <button class="btn small charcoal" data-action="pay-items" data-method="DuitNow/eWallet" ${ready ? '' : 'disabled'}>${esc(t('split.items.payEwallet'))}</button>
    </div>`;
}

function itemSplitSummary() {
  const err = itemSplit.error ? `<div class="err">${esc(itemSplit.error)}</div>` : '';
  if (!itemSplit.selected.size) return err + esc(t('split.items.none'));
  if (!itemSplit.preview) return err || esc(t('split.items.working'));
  const p = itemSplit.preview;
  const cash = Math.round(p.amount * 20) / 20;
  let s = `<b>${esc(fill(t('split.items.total'), { amount: fmt(p.amount) }))}</b>`;
  if (p.last) {
    s += ` <span class="meta">${esc(t('split.items.last'))}</span>`;
    if (Math.abs(cash - p.amount) > 0.001) s += ` <span class="meta">${esc(fill(t('split.items.cash'), { amount: fmt(cash) }))}</span>`;
  }
  return err + s;
}

async function toggleSplitItem(id, checked) {
  if (!itemSplit) return;
  if (checked) itemSplit.selected.add(id); else itemSplit.selected.delete(id);
  itemSplit.preview = null;
  itemSplit.error = '';
  renderItemSplit();
  if (!itemSplit.selected.size) return;
  const seq = ++itemPreviewSeq;
  try {
    const p = await API.get(`/api/orders/${currentOrder.id}/split?by=items&items=${[...itemSplit.selected].join(',')}`);
    if (seq !== itemPreviewSeq || !itemSplit) return;
    itemSplit.preview = p;
  } catch (e) {
    if (seq !== itemPreviewSeq || !itemSplit) return;
    itemSplit.error = e.message;
  }
  renderItemSplit();
}

async function payItems(method) {
  if (!itemSplit?.preview || !itemSplit.selected.size) return;
  if (!navigator.onLine) return toast('Cannot take payment while offline');
  if (payBusy) return;
  payBusy = true;
  try {
    const r = await API.post(`/api/orders/${currentOrder.id}/pay`, {
      method, item_ids: [...itemSplit.selected], amount: itemSplit.preview.amount,
    });
    if (r.settled) {
      closePayModal();
      toast(r.change > 0 ? `Paid — change ${fmt(r.change)}` : 'Paid in full');
      backToTables();
      return;
    }
    toast(`Paid ${fmt(r.paid)} — ${fmt(r.remaining)} left`);
    itemSplit = { selected: new Set(), preview: null, error: '' };
    await refreshPayModal();
  } catch (e) {
    // Refused — most likely the bill changed since the amount was shown. Say
    // why, and show what the ticked lines come to now.
    itemSplit.error = e.message;
    itemSplit.preview = null;
    try { itemSplit.preview = await API.get(`/api/orders/${currentOrder.id}/split?by=items&items=${[...itemSplit.selected].join(',')}`); }
    catch { /* the error already says what is wrong */ }
    renderItemSplit();
  } finally { payBusy = false; }
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
  else if (a === 'select-legacy') selectLegacy(Number(el.dataset.id));
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
  else if (a === 'open-combine') openCombine();
  else if (a === 'leave-group') leaveGroup();
  else if (a === 'separate-card') separateCard(Number(el.dataset.id), Number(el.dataset.number));
  else if (a === 'scroll-to-bill') $('bill-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

$('combine-modal').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el?.dataset.action === 'close-combine' || e.target === $('combine-modal')) closeCombine();
  else if (el?.dataset.action === 'confirm-combine') confirmCombine();
});

$('pay-modal').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) {
    const a = el.dataset.action;
    if (a === 'pay') payFull(el.dataset.method);
    else if (a === 'pay-amount') payAmount(el.dataset.method || 'Cash');
    else if (a === 'pay-group-legs') payGroupLegs();
    else if (a === 'pay-share') paySplitShare(Number(el.dataset.idx), el.dataset.method || 'Cash');
    else if (a === 'split-evenly') splitEvenlyUI();
    else if (a === 'split-by-items') splitByItemsUI();
    else if (a === 'pay-items') payItems(el.dataset.method || 'Cash');
    else if (a === 'toggle-pay-part') togglePayPart();
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
  else if (e.target.dataset.action === 'split-item') toggleSplitItem(Number(e.target.value), e.target.checked);
});
$('cash-received-input').addEventListener('input', updateChangeDue);
['group-cash-part', 'group-cash-received'].forEach(id => $(id).addEventListener('input', updateGroupLegsSummary));
$('group-rest-method').addEventListener('change', updateGroupLegsSummary);

/* Realtime: a change on any card's order updates the floor live, or — if this
   device is inside that order's workspace — its bill and pay button. */
onStreamEvent(batch => {
  if (batch.some(e => e.type === 'menu.updated')) loadAll();
  if (!document.getElementById('tab-pos')?.classList.contains('active')) return;
  if (!state.selTable) renderTables();
  else checkOpenOrder();
  if (batch.some(e => e.type.startsWith('order.'))) payModalLiveCheck();
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
// Orders the server refused for good (e.g. the card was combined into another
// while this was on its way). Listed until someone taps OK, so a dish that
// never reached the kitchen can't vanish without a word.
async function renderFailedSends() {
  const box = $('outbox-failed');
  if (!box) return;
  const failed = (await failedEntries().catch(() => [])).sort((a, b) => a.createdAt - b.createdAt);
  box.hidden = !failed.length;
  box.innerHTML = failed.map(f => `
    <div class="outbox-failed-row">
      <div><strong>Not sent${f.meta?.label ? ` — ${esc(f.meta.label)}` : ''}:</strong>
        ${esc((f.meta?.lines || []).join(', ') || 'an order')}
        <div class="outbox-failed-why">${esc(f.error || '')}. Add it again on the right card.</div></div>
      <button class="btn small" data-action="dismiss-failed" data-id="${esc(f.id)}">OK</button>
    </div>`).join('');
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-action="dismiss-failed"]');
  if (b) dismissFailed(b.dataset.id).then(renderFailedSends);
});

let knownFailed = null;
onOutboxChange(async () => {
  const n = (await failedEntries().catch(() => [])).length;
  if (knownFailed != null && n > knownFailed) toast('An order was NOT sent — see the red note at the top');
  knownFailed = n;
  renderFailedSends();
});
renderFailedSends();

onOutboxChange(() => {
  updateOfflineBanner();
  if (state.selTable) checkOpenOrder();
});
window.addEventListener('online', updateOfflineBanner);
window.addEventListener('offline', updateOfflineBanner);
updateOfflineBanner();
