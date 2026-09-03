import { state, $, fmt, esc, toast } from './state.js';

/* ===== DATA LOADING ===== */
export async function loadAll() {
  try {
    [state.menu, state.tables] = await Promise.all([API.get('/api/menu'), API.get('/api/tables')]);
    state.activeCat = state.menu.categories[0]?.id;
    renderTables();
    renderMenu();
  } catch (e) { toast('Failed to load data: ' + e.message); }
}

/* ===== POS: TABLES ===== */
export async function renderTables() {
  let orders = [];
  try { orders = await API.get('/api/orders'); } catch (e) {}

  const tableStatus = {};
  orders.forEach(o => {
    if (!tableStatus[o.table_id]) tableStatus[o.table_id] = o.status;
  });

  $('pos-tables').innerHTML = `<h2 style="margin-bottom:14px">Select a Table</h2>
    <div class="tables-grid">${state.tables.map(t => {
      const status = tableStatus[t.id];
      const statusClass = status ? (status === 'served' ? 'busy' : 'open') : '';
      const statusLabel = status ? `<div class="table-status">${status}</div>` : '';
      return `<button class="table-btn ${statusClass}" id="tb-${t.id}" data-action="select-table" data-id="${t.id}">
        ${esc(t.name)}${statusLabel}
      </button>`;
    }).join('')}</div>`;
}

function selectTable(id) {
  const t = state.tables.find(x => x.id === id);
  state.selTable = { id, name: t ? t.name : '' };
  state.cart = [];
  $('pos-tables').style.display = 'none';
  $('pos-workspace').style.display = '';
  $('ws-title').textContent = state.selTable.name;
  renderCart();
  renderMenu();
  checkOpenOrder();
}

function backToTables() {
  $('pos-workspace').style.display = 'none';
  $('pos-tables').style.display = '';
  state.selTable = null;
  state.cart = [];
  renderTables();
}

async function checkOpenOrder() {
  try {
    const orders = await API.get('/api/orders');
    const open = orders.find(o => o.table_id === state.selTable.id);
    if (open) {
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
      $('pay-btn').style.display = 'none';
    }
  } catch (e) {}
}

/* ===== POS: MENU ===== */
function renderMenu() {
  if (!state.activeCat && state.menu.categories.length) state.activeCat = state.menu.categories[0].id;
  $('menu-cats').innerHTML = state.menu.categories.map(c =>
    `<button class="${c.id === state.activeCat ? 'active' : ''}" data-action="set-cat" data-id="${c.id}">${esc(c.name)}</button>`
  ).join('');
  const items = state.menu.items.filter(i => i.category_id === state.activeCat);
  $('menu-items').innerHTML = items.map(it =>
    `<button class="item-btn" data-action="add-item" data-id="${it.id}">
      <div class="nm">${esc(it.name)}</div><div class="pr">${fmt(it.price)}</div></button>`
  ).join('') || '<div class="empty">No items in this category</div>';
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
  let total = 0;
  $('cart-lines').innerHTML = state.cart.map((l, i) => {
    const lt = (l.price + l.mods.reduce((s, m) => s + m.price, 0)) * l.qty;
    if (!l.voided) total += lt;
    const modStr = l.mods.map(m => m.name + (m.price ? ` +${fmt(m.price)}` : '')).join(', ');
    const tag = l.voided
      ? ` <small class="sent-tag" style="color:var(--red)">VOID${l.void_reason ? ': ' + esc(l.void_reason) : ''}</small>`
      : (l.sent ? ' <small class="sent-tag">sent</small>' : '');
    const controls = l.voided ? ''
      : l.sent ? `<button data-action="void-line" data-id="${i}" style="color:var(--red)">Void</button>`
      : `<div class="qty"><button data-action="cart-qty" data-id="${i}" data-delta="-1">−</button><button data-action="cart-qty" data-id="${i}" data-delta="1">+</button><button data-action="cart-del" data-id="${i}" style="color:var(--red)">✕</button></div>`;
    const seatBadge = l.seat != null ? `<br><small style="color:var(--warm-gray)">Seat ${esc(String(l.seat))}</small>` : '';
    const seatInput = (l.voided || l.sent) ? '' :
      `<input type="number" min="1" placeholder="Seat" value="${l.seat ?? ''}" data-action="set-seat" data-id="${i}"
        style="width:56px;color:var(--charcoal);margin-top:6px;font-size:12px;padding:4px 6px">`;
    return `<div class="cart-line"${l.voided ? ' style="opacity:.55"' : ''}>
      <div><b>${l.qty}×</b> ${esc(l.name)}${tag}${modStr ? `<br><small style="color:var(--warm-gray)">${esc(modStr)}</small>` : ''}${l.note ? `<br><small style="color:var(--terra)">📝 ${esc(l.note)}</small>` : ''}${seatBadge}${seatInput}</div>
      <div style="display:flex;align-items:center;gap:10px"><span${l.voided ? ' style="text-decoration:line-through"' : ''}>${fmt(lt)}</span>
        ${controls}
      </div></div>`;
  }).join('');
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
    const label = g.min_select > 0 ? `${esc(g.name)} (choose ${g.min_select === g.max_select ? g.min_select : `${g.min_select}-${g.max_select}`})` : esc(g.name);
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

/* ===== SEND ORDER ===== */
async function sendOrder() {
  if (!state.selTable || !state.cart.length) return toast('Add items first');
  const pending = state.cart.filter(l => !l.sent);
  if (!pending.length) return toast('No new items to send');
  try {
    const orders = await API.get('/api/orders');
    const existing = orders.find(o => o.table_id === state.selTable.id);

    const items = pending.map(l => ({
      item_id: l.item_id,
      qty: l.qty,
      note: l.note,
      seat: l.seat || null,
      modifier_option_ids: l.mods.map(m => {
        const opt = state.menu.modifier_options.find(o => o.name === m.name);
        return opt ? opt.id : null;
      }).filter(Boolean)
    }));

    if (existing) {
      await API.post(`/api/orders/${existing.id}/items`, { items });
      toast('Items added to existing order');
    } else {
      await API.post('/api/orders', { table_id: state.selTable.id, items });
      toast('Order sent to kitchen!');
    }

    state.cart = []; renderCart();
    checkOpenOrder();
    renderTables();
  } catch (e) {
    // Another tablet won the race to open this table first (one_open_order_per_table).
    // Join that order instead of failing outright.
    if (e.status === 409 && e.body?.order_id) {
      try {
        const items = pending.map(l => ({
          item_id: l.item_id, qty: l.qty, note: l.note, seat: l.seat || null,
          modifier_option_ids: l.mods.map(m => {
            const opt = state.menu.modifier_options.find(o => o.name === m.name);
            return opt ? opt.id : null;
          }).filter(Boolean),
        }));
        await API.post(`/api/orders/${e.body.order_id}/items`, { items });
        toast('Another order was already open for this table — joined it');
        state.cart = []; renderCart();
        checkOpenOrder();
        renderTables();
        return;
      } catch (e2) { toast('Error: ' + e2.message); console.error(e2); return; }
    }
    toast('Error: ' + e.message); console.error(e);
  }
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

  if (o.payments?.length) {
    rows.push(`<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--light-gray)"><b>Paid so far</b></div>`);
    o.payments.forEach(p => rows.push(`<div><small>${esc(p.method)}</small> <span style="float:right"><small>${fmt(p.amount)}</small></span></div>`));
  }
  rows.push(`<div style="font-weight:700;color:var(--terra);margin-top:6px">Remaining <span style="float:right">${fmt(o.amount_due)}</span></div>`);

  $('pay-details').innerHTML = `<div style="font-size:14px;color:var(--warm-gray);margin-bottom:8px">Order #${o.id}</div>${rows.join('')}`;
  $('pay-amount-input').value = '';
  $('cash-received-input').value = '';
  $('pay-change-due').textContent = '';
  $('pay-cash-row').style.display = '';
  $('pay-amount-row').style.display = '';
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
    else if (action === 'close-pay-modal') closePayModal();
    return;
  }
  if (e.target === $('pay-modal')) closePayModal();
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
