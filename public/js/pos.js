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
        note: l.note || '', sent: true, voided: l.voided, void_reason: l.void_reason,
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
  if (it.kandar) { openKandarModal(it); return; }

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
    return `<div class="cart-line"${l.voided ? ' style="opacity:.55"' : ''}>
      <div><b>${l.qty}×</b> ${esc(l.name)}${tag}${modStr ? `<br><small style="color:var(--warm-gray)">${esc(modStr)}</small>` : ''}${l.note ? `<br><small style="color:var(--terra)">📝 ${esc(l.note)}</small>` : ''}</div>
      <div style="display:flex;align-items:center;gap:10px"><span${l.voided ? ' style="text-decoration:line-through"' : ''}>${fmt(lt)}</span>
        ${controls}
      </div></div>`;
  }).join('');
  $('cart-total-rm').textContent = fmt(total);
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

/* ===== KANDAR MODAL ===== */
function openKandarModal(it) {
  state.kandarItem = it;
  $('mod-title').textContent = it.name + ' — ' + fmt(it.price);
  const kuahG = state.menu.modifier_groups.find(g => g.mode === 'radio');
  const extraG = state.menu.modifier_groups.find(g => g.mode === 'checkbox');
  const kuahOpts = state.menu.modifier_options.filter(o => o.group_id === kuahG?.id);
  const extraOpts = state.menu.modifier_options.filter(o => o.group_id === extraG?.id);
  let html = '';
  if (kuahOpts.length) {
    html += `<div style="font-size:12px;color:var(--warm-gray);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:8px">Kuah</div>`;
    html += kuahOpts.map((o, i) => `<div class="mod-opt"><input type="radio" name="kuah" value="${o.id}" ${i === 0 ? 'checked' : ''}><span>${esc(o.name)}</span></div>`).join('');
  }
  if (extraOpts.length) {
    html += `<div style="font-size:12px;color:var(--warm-gray);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin:14px 0 8px">Extra Lauk</div>`;
    html += extraOpts.map(o => `<div class="mod-opt"><input type="checkbox" name="extra" value="${o.id}" data-price="${o.price}"><span style="flex:1">${esc(o.name)}</span><span style="color:var(--terra);font-weight:700">+${fmt(o.price)}</span></div>`).join('');
  }
  $('mod-body').innerHTML = html;
  $('mod-remark').value = '';

  // Food presets for kandar
  const presets = ['Kurang pedas', 'No onion', 'Extra spicy', 'Kurang minyak', 'Banjir sikit'];
  $('mod-presets').innerHTML = presets.map(p =>
    `<button class="btn small outline" data-action="set-mod-remark" data-value="${esc(p)}">${esc(p)}</button>`
  ).join('');

  $('modal-bg').classList.add('show');
}

function closeModal() { $('modal-bg').classList.remove('show'); state.kandarItem = null; }

function confirmKandar() {
  if (!state.kandarItem) return;
  const kuahId = document.querySelector('input[name="kuah"]:checked')?.value;
  const mods = [];
  if (kuahId) { const o = state.menu.modifier_options.find(x => x.id == kuahId); if (o) mods.push({ name: o.name, price: o.price }); }
  document.querySelectorAll('input[name="extra"]:checked').forEach(c => {
    const o = state.menu.modifier_options.find(x => x.id == c.value); if (o) mods.push({ name: o.name, price: o.price });
  });
  const note = $('mod-remark').value.trim();
  state.cart.push({ item_id: state.kandarItem.id, name: state.kandarItem.name, price: state.kandarItem.price, qty: 1, mods, note });
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
          item_id: l.item_id, qty: l.qty, note: l.note,
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
   This is an estimate for the cashier's display only — the server never trusts
   it and recomputes the real bill from order_items at /api/orders/:id/pay. */
const roundHalfUp = n => (n >= 0 ? Math.floor(n + 0.5) : -Math.floor(-n + 0.5));
let payPreview = null;

async function openPayModal() {
  const orderId = $('pay-btn').dataset.orderId;
  if (!orderId) return;

  try {
    const orders = await API.get('/api/orders');
    const order = orders.find(o => o.id == orderId);
    if (order && ['sent', 'preparing'].includes(order.status)) {
      if (!confirm(`⚠️ Food is still ${order.status}. Are you sure you want to mark as paid?`)) {
        return;
      }
    }
  } catch (e) {}

  const subtotalCents = Math.round(state.cart.reduce((s, l) =>
    s + (l.price + l.mods.reduce((a, m) => a + m.price, 0)) * l.qty, 0) * 100);
  let taxRateBp = 600, svcRateBp = 0;
  try { const settings = await API.get('/api/settings'); taxRateBp = settings.tax_rate_bp; svcRateBp = settings.svc_rate_bp; } catch (e) {}

  const serviceChargeCents = roundHalfUp(subtotalCents * svcRateBp / 10000);
  const taxCents = roundHalfUp((subtotalCents + serviceChargeCents) * taxRateBp / 10000);
  const grossCents = subtotalCents + serviceChargeCents + taxCents;
  const cashTotalCents = Math.round(grossCents / 5) * 5;
  const roundingCents = cashTotalCents - grossCents;
  payPreview = { cashTotalCents };

  const rows = [`<div>Subtotal <span style="float:right">${fmt(subtotalCents / 100)}</span></div>`];
  if (serviceChargeCents) rows.push(`<div>Service charge <span style="float:right">${fmt(serviceChargeCents / 100)}</span></div>`);
  rows.push(`<div>SST ${(taxRateBp / 100).toFixed(0)}% <span style="float:right">${fmt(taxCents / 100)}</span></div>`);
  rows.push(`<div>Rounding (cash) <span style="float:right">${roundingCents >= 0 ? '+' : ''}${fmt(roundingCents / 100)}</span></div>`);
  rows.push(`<div style="font-weight:700;margin-top:6px">Total (Card/eWallet) <span style="float:right">${fmt(grossCents / 100)}</span></div>`);
  rows.push(`<div style="font-weight:700">Total (Cash) <span style="float:right">${fmt(cashTotalCents / 100)}</span></div>`);

  $('pay-details').innerHTML = `<div style="font-size:14px;color:var(--warm-gray);margin-bottom:8px">Order #${orderId}</div>${rows.join('')}`;
  $('cash-received-input').value = '';
  $('pay-change-due').textContent = '';
  $('pay-cash-row').style.display = '';
  $('pay-modal').classList.add('show');
}

function closePayModal() { $('pay-modal').classList.remove('show'); }

function updateChangeDue() {
  if (!payPreview) return;
  const receivedCents = Math.round(Number($('cash-received-input').value || 0) * 100);
  const changeCents = receivedCents - payPreview.cashTotalCents;
  $('pay-change-due').textContent = receivedCents ? `Change due: ${fmt(Math.max(0, changeCents) / 100)}` : '';
  $('pay-change-due').style.color = changeCents < 0 ? 'var(--red)' : 'var(--charcoal)';
}

async function processPay(method) {
  const orderId = $('pay-btn').dataset.orderId;
  if (method === 'Cash' && payPreview) {
    const receivedCents = Math.round(Number($('cash-received-input').value || 0) * 100);
    if (receivedCents < payPreview.cashTotalCents) return toast('Cash received is less than the total due');
  }
  try {
    const r = await API.post(`/api/orders/${orderId}/pay`, { method });
    closePayModal();
    state.cart = []; renderCart();
    $('pay-btn').style.display = 'none';
    if (method === 'Cash') {
      const receivedCents = Math.round(Number($('cash-received-input').value || 0) * 100);
      const changeCents = receivedCents - Math.round(r.bill.total * 100);
      toast(`Paid ${fmt(r.bill.total)} cash — change ${fmt(Math.max(0, changeCents) / 100)}`);
    } else {
      toast(`Paid with ${method} — ${fmt(r.bill.total)}`);
    }
    renderTables();
  } catch (e) { toast('Payment failed: ' + e.message); }
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

$('modal-bg').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) {
    const action = el.dataset.action;
    if (action === 'set-mod-remark') $('mod-remark').value = el.dataset.value;
    else if (action === 'close-kandar-modal') closeModal();
    else if (action === 'confirm-kandar') confirmKandar();
    return;
  }
  if (e.target === $('modal-bg')) closeModal();
});

$('pay-modal').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) {
    const action = el.dataset.action;
    if (action === 'pay') processPay(el.dataset.method);
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
