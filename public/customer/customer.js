import { $, fmt, esc, toast, stateWords } from '../js/state.js';
import '../js/i18n.js';
import { initVoice, applyChoice, reopenReview } from './voice.js';

/* ===== CUSTOMER QR PAGE =====
   Deliberately tiny: a menu, a basket, and honest progress on what the kitchen
   is doing with your food. No internal POS controls, no prices staff can edit
   from here, no order ids — this page only ever knows the table's own QR token
   and an opaque reference to each round it sent. */

let menu = { categories: [], items: [], modifier_groups: [], modifier_options: [], stations: [] };
let tableToken = null, tableName = '';
let ordering = { enabled: true, approval_required: false };
let cart = [];
let activeCat = null;
let modItem = null;
// The food-options dialog serves two callers now: the basket, and a voice line
// whose group question the customer still has to answer.
let modMode = 'cart';
let pendingItem = null;
// Rounds this phone has sent, newest last. Kept in sessionStorage so a reload
// (or the phone locking) doesn't lose track of food already on its way.
let myRounds = [];
let statusTimer = null;

const STORE_KEY = () => `mamak_rounds_${tableToken}`;
function loadRounds() {
  try { myRounds = JSON.parse(sessionStorage.getItem(STORE_KEY()) || '[]'); } catch { myRounds = []; }
}
function saveRounds() {
  try { sessionStorage.setItem(STORE_KEY(), JSON.stringify(myRounds)); } catch { /* private mode */ }
}

async function init() {
  const parts = window.location.pathname.split('/');
  tableToken = parts[parts.length - 1];
  if (!tableToken || tableToken === 'customer.html') return fail('Invalid QR code', 'Please scan the QR at your table.');

  try {
    const info = await fetch('/api/t/' + tableToken).then(r => r.json());
    if (info.error) return fail('This QR code is not in use', 'Please ask our staff for help.');
    tableName = info.table.name;
    ordering = info.ordering;
    $('table-name').textContent = tableName;
    loadRounds();

    if (!ordering.enabled) {
      $('loading').style.display = 'none';
      $('paused-message').textContent = info.paused_message;
      $('paused-view').style.display = '';
      return;
    }

    menu = await fetch('/api/menu').then(r => r.json());
    activeCat = menu.categories[0]?.id;
    $('loading').style.display = 'none';
    $('app').style.display = '';
    renderCats(); renderItems(); updateBar(); renderMyOrders();
    startStatusPolling();

    // Speak to Order appears only when the restaurant has configured it AND
    // this browser can actually record. Otherwise the page is exactly what it
    // was: a menu you tap.
    if (info.voice && info.voice.enabled) {
      initVoice({
        tableToken,
        menu,
        onConfirm: items => postRound(items),
        onAddMore: mergeVoiceDraftIntoBasket,
        onBrowse: () => {
          $('menu-cats').scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      });
    }
  } catch (e) {
    fail('Could not load the menu', 'Check your connection and try again.');
  }
}

function fail(title, detail) {
  $('loading').innerHTML = `<div style="color:var(--terra-deep);font-weight:700;font-size:18px">${esc(title)}</div>
    <div class="meta" style="margin-top:6px">${esc(detail)}</div>`;
}

/* ===== MENU ===== */
function renderCats() {
  $('menu-cats').innerHTML = menu.categories.map(c =>
    `<button class="${c.id === activeCat ? 'active' : ''}" aria-pressed="${c.id === activeCat}"
       data-action="set-cat" data-id="${c.id}">${esc(c.name)}</button>`).join('');
  const active = $('menu-cats').querySelector('button.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

function renderItems() {
  const items = menu.items.filter(i => i.category_id === activeCat);
  $('menu-items').innerHTML = items.map(it =>
    `<button class="item-btn" data-action="add-item" data-id="${it.id}">
      <span class="info">
        <span class="nm">${esc(it.name)}</span>
        ${(it.modifier_group_ids || []).length ? '<span class="customisable">Choices available</span>' : ''}
      </span>
      <span class="pr">${fmt(it.price)}</span>
      <span class="add" aria-hidden="true">＋</span>
    </button>`).join('') || '<div class="empty">No items in this category</div>';
}

const PRESETS_DRINK = ['Kurang manis', 'Tak nak ais', 'Less ice', 'Extra hot'];
const PRESETS_FOOD = ['Kurang pedas', 'Tambah telur', 'Tak nak bawang', 'Banjir'];
const presetsFor = it => (it.station_code === 'drinks' ? PRESETS_DRINK : PRESETS_FOOD);

function addItem(id) {
  const it = menu.items.find(i => i.id === id);
  if (!it) return;
  if ((it.modifier_group_ids || []).length) return openModifiers(it);

  pendingItem = it;
  $('rm-title').textContent = it.name;
  $('rm-presets').innerHTML = presetsFor(it).map(p =>
    `<button class="btn small outline" data-action="set-remark" data-value="${esc(p)}">${esc(p)}</button>`).join('');
  $('rm-input').value = '';
  $('remark-modal').classList.add('show');
}

function pushLine(it, mods, note) {
  const same = cart.find(l => l.item_id === it.id && l.note === note
    && l.mods.length === mods.length && l.mods.every((m, i) => m.name === mods[i].name));
  if (same) same.qty++;
  else cart.push({ item_id: it.id, name: it.name, price: it.price, qty: 1, mods, note });
}

function finishRemark(note) {
  if (pendingItem) { pushLine(pendingItem, [], note); pendingItem = null; }
  closeRemarkModal(); updateBar();
}
function closeRemarkModal() { $('remark-modal').classList.remove('show'); pendingItem = null; }

/* ===== FOOD OPTIONS ===== */
function modifierGroupsFor(it) {
  return (it.modifier_group_ids || []).map(gid => menu.modifier_groups.find(g => g.id === gid)).filter(Boolean);
}

function openModifiers(it, mode = 'cart') {
  modItem = it;
  modMode = mode;
  $('km-title').textContent = `${it.name} — ${fmt(it.price)}`;
  $('km-body').innerHTML = modifierGroupsFor(it).map(g => {
    const opts = menu.modifier_options.filter(o => o.group_id === g.id);
    const inputType = g.mode === 'radio' ? 'radio' : 'checkbox';
    const label = g.min_select > 0
      ? `${esc(g.name)} — choose ${g.min_select === g.max_select ? g.min_select : `${g.min_select}–${g.max_select}`}`
      : `${esc(g.name)} — optional`;
    return `<div class="label" style="margin:16px 0 6px">${label}</div>` + opts.map(o =>
      `<label class="mod-opt"><input type="${inputType}" name="grp-${g.id}" data-group="${g.id}" value="${o.id}">
        <span style="flex:1">${esc(o.name)}</span>
        ${o.price ? `<span style="color:var(--terra-deep);font-weight:800">+${fmt(o.price)}</span>` : ''}</label>`).join('');
  }).join('');
  $('km-remark').value = '';
  $('km-presets').innerHTML = presetsFor(it).map(p =>
    `<button class="btn small outline" data-action="set-mod-remark" data-value="${esc(p)}">${esc(p)}</button>`).join('');
  updateModifierValidity();
  $('kandar-modal').classList.add('show');
}

function updateModifierValidity() {
  const btn = $('km-confirm-btn');
  if (!modItem || !btn) return;
  btn.disabled = !modifierGroupsFor(modItem).every(g => {
    const count = document.querySelectorAll(`input[data-group="${g.id}"]:checked`).length;
    return count >= g.min_select && count <= g.max_select;
  });
}

function closeKandar() {
  $('kandar-modal').classList.remove('show');
  const wasVoice = modMode === 'voice';
  modItem = null; modMode = 'cart';
  // Cancelling out of a voice line's question puts the customer back in front
  // of their proposal rather than dropping them on the menu with nothing.
  if (wasVoice) reopenReview();
}

function confirmModifiers() {
  if (!modItem) return;
  const mods = [];
  modifierGroupsFor(modItem).forEach(g => {
    document.querySelectorAll(`input[data-group="${g.id}"]:checked`).forEach(inp => {
      const o = menu.modifier_options.find(x => x.id == inp.value);
      if (o) mods.push({ id: o.id, name: o.name, price: o.price });
    });
  });
  const it = modItem;
  const wasVoice = modMode === 'voice';
  const note = $('km-remark').value.trim();
  $('kandar-modal').classList.remove('show');
  modItem = null; modMode = 'cart';
  if (wasVoice) return applyChoice(mods);
  pushLine(it, mods, note);
  updateBar();
}

/* ===== BASKET ===== */
function updateBar() {
  const count = cart.reduce((s, l) => s + l.qty, 0);
  const total = cart.reduce((s, l) => s + (l.price + l.mods.reduce((a, m) => a + m.price, 0)) * l.qty, 0);
  $('bar-count').textContent = count;
  $('bar-total').textContent = fmt(total);
  $('cart-bar').style.display = count ? '' : 'none';
}

function showCart() {
  if (!cart.length) {
    $('cart-lines').innerHTML = ''; $('cart-empty').style.display = ''; $('cart-totals').style.display = 'none';
  } else {
    $('cart-empty').style.display = 'none'; $('cart-totals').style.display = '';
    let total = 0;
    $('cart-lines').innerHTML = cart.map((l, i) => {
      const lt = (l.price + l.mods.reduce((s, m) => s + m.price, 0)) * l.qty; total += lt;
      const sub = [l.mods.map(m => m.name + (m.price ? ` +${fmt(m.price)}` : '')).join(', '), l.note ? `📝 ${l.note}` : '']
        .filter(Boolean).map(esc).join(' · ');
      return `<div class="cart-line">
        <div><div class="line-name">${l.qty}× ${esc(l.name)}</div>${sub ? `<div class="line-sub">${sub}</div>` : ''}</div>
        <div class="line-right"><span>${fmt(lt)}</span>
          <div class="qty">
            <button data-action="cart-qty" data-id="${i}" data-delta="-1" aria-label="One fewer">−</button>
            <button data-action="cart-qty" data-id="${i}" data-delta="1" aria-label="One more">+</button>
            <button data-action="cart-del" data-id="${i}" aria-label="Remove">✕</button>
          </div></div></div>`;
    }).join('');
    $('cart-total-rm').textContent = fmt(total);
  }
  $('cart-modal').classList.add('show');
}

function closeCartModal() { $('cart-modal').classList.remove('show'); }
function cq(i, d) { cart[i].qty = Math.max(1, cart[i].qty + d); updateBar(); showCart(); }
function cd(i) { cart.splice(i, 1); updateBar(); if (cart.length) showCart(); else closeCartModal(); }

/* ===== SUBMIT =====
   One path out of this page, whichever way the order was built. Voice and the
   basket both end up here, and here posts to the same public endpoint it always
   did — which re-validates every line, applies the restaurant's own prices, and
   appends a kitchen round to whatever bill the table already has. */
async function postRound(items) {
  const r = await fetch('/api/public/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ table_token: tableToken, items }),
  });
  const body = await r.json().catch(() => ({}));

  if (r.status === 503) { $('paused-message').textContent = body.message; showPaused(); return null; }
  if (r.status === 409) { showBlocked(body.message); return null; }
  if (r.status === 429) { showBlocked('Too many orders from this table just now. Please ask our staff.'); return null; }
  if (!r.ok) throw new Error(body.error === 'invalid items' ? 'Something on that order is no longer available.' : (body.message || body.error || 'failed'));

  myRounds.push({
    ref: body.ref, round: body.round, status: body.status,
    items: items.map(l => ({ name: nameOf(l.item_id), qty: l.qty })),
  });
  saveRounds();
  cart = [];
  closeCartModal();
  updateBar();
  showSuccess();
  startStatusPolling();
  return body;
}

const nameOf = id => menu.items.find(i => i.id === id)?.name || 'Item';

async function submitOrder() {
  if (!cart.length) return;
  const btn = $('submit-btn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    await postRound(cart.map(l => ({
      item_id: l.item_id, qty: l.qty, note: l.note,
      modifier_option_ids: l.mods.map(m => m.id != null ? m.id
        : menu.modifier_options.find(o => o.name === m.name)?.id).filter(Boolean),
    })));
  } catch (e) {
    toast(e.message || 'Could not send your order. Please try again or ask our staff.');
  } finally {
    btn.disabled = false; btn.textContent = 'Place Order';
  }
}

/* "Add more from the menu" on the voice preview: the spoken order becomes the
   basket, so there is never a second cart to reconcile. */
function mergeVoiceDraftIntoBasket(lines) {
  lines.forEach(l => {
    cart.push({
      item_id: l.item_id, name: l.name, price: l.unit_price, qty: l.qty,
      mods: l.mods.map(m => ({ id: m.id, name: m.name, price: m.price })),
      note: l.note || '',
    });
  });
  updateBar();
  $('menu-cats').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Added to your order — keep going.');
}

function showPaused() {
  $('app').style.display = 'none'; $('cart-bar').style.display = 'none'; $('cart-modal').classList.remove('show');
  $('paused-view').style.display = '';
}

function showBlocked(message) {
  closeCartModal();
  $('app').style.display = 'none'; $('cart-bar').style.display = 'none';
  $('paused-message').textContent = message || 'Please order with our staff.';
  $('paused-view').style.display = '';
}

/* ===== "WHERE IS MY FOOD" =====
   Real state, polled from the round's own opaque reference — never a fake
   "live" indicator. Rejected rounds say so rather than waiting forever. */
const STEPS = [
  { key: 'sent', label: 'Sent' },
  { key: 'preparing', label: 'Cooking' },
  { key: 'ready', label: 'Ready' },
  { key: 'served', label: 'Served' },
];

function stepsHtml(status) {
  if (status === 'pending') return '<span class="c-step now">⏳ Waiting for staff</span>';
  if (status === 'rejected') return '<span class="c-step" style="background:var(--red-pale);color:var(--red)">Not available</span>';
  const idx = STEPS.findIndex(s => s.key === status);
  return STEPS.map((s, i) =>
    `<span class="c-step ${i < idx ? 'done' : i === idx ? 'now' : ''}">${stateWords(s.key).icon} ${esc(s.label)}</span>`).join('');
}

function showSuccess() {
  const latest = myRounds[myRounds.length - 1];
  if (!latest) return;
  $('app').style.display = 'none';
  $('cart-bar').style.display = 'none';
  $('success-view').style.display = '';
  $('success-table').textContent = `Table ${tableName}`;
  renderSuccess(latest);
}

function renderSuccess(round) {
  $('success-steps').innerHTML = stepsHtml(round.status);
  $('success-status').textContent =
    round.status === 'pending' ? 'A staff member is checking your order.'
    : round.status === 'rejected' ? 'Our staff could not take this order — please ask them.'
    : round.status === 'served' ? 'Enjoy your meal!'
    : 'The kitchen has your order.';
  $('success-items').innerHTML = round.items.map(i =>
    `<div class="row"><span>${i.qty}× ${esc(i.name)}</span></div>`).join('');
}

/* A short summary at the top of the menu once this phone has ordered
   something, so "Order more" doesn't lose sight of what is already coming. */
function renderMyOrders() {
  if (!myRounds.length) { $('my-orders').innerHTML = ''; return; }
  $('my-orders').innerHTML = `<div class="card" style="margin-bottom:14px">
    <h3 style="font-size:16px;margin-bottom:10px">Your order so far</h3>
    ${myRounds.map(r => `<div class="cart-line">
      <div><div class="line-name">${r.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</div></div>
      <div class="line-right"><span class="round-tag ${esc(r.status)}">${stateWords(r.status).icon} ${esc(stateWords(r.status).label)}</span></div>
    </div>`).join('')}
  </div>`;
}

async function pollStatus() {
  if (!myRounds.length) return;
  await Promise.all(myRounds.map(async r => {
    try {
      const s = await fetch(`/api/public/sends/${r.ref}`).then(x => x.json());
      if (s && !s.error) r.status = s.status;
    } catch { /* keep the last known state */ }
  }));
  saveRounds();
  renderMyOrders();
  if ($('success-view').style.display !== 'none') renderSuccess(myRounds[myRounds.length - 1]);
}

function startStatusPolling() {
  clearInterval(statusTimer);
  if (!myRounds.length) return;
  pollStatus();
  // 15s: this page has no session, so it cannot use the staff event stream.
  // Slow enough to be free, fast enough that "Ready" arrives while it matters.
  statusTimer = setInterval(pollStatus, 15000);
}

function orderMore() {
  $('success-view').style.display = 'none';
  $('app').style.display = '';
  updateBar();
  renderMyOrders();
  window.scrollTo({ top: 0 });
}

/* ===== EVENT WIRING ===== */
document.body.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'set-cat') { activeCat = Number(el.dataset.id); renderCats(); renderItems(); }
  else if (a === 'add-item') addItem(Number(el.dataset.id));
  else if (a === 'show-cart') showCart();
  else if (a === 'close-cart-modal') closeCartModal();
  else if (a === 'submit-order') submitOrder();
  else if (a === 'cart-qty') cq(Number(el.dataset.id), Number(el.dataset.delta));
  else if (a === 'cart-del') cd(Number(el.dataset.id));
  else if (a === 'order-more') orderMore();
  else if (a === 'close-mods') closeKandar();
  else if (a === 'confirm-mods') confirmModifiers();
  else if (a === 'set-mod-remark') $('km-remark').value = el.dataset.value;
  else if (a === 'skip-remark') finishRemark('');
  else if (a === 'confirm-remark') finishRemark($('rm-input').value.trim());
  else if (a === 'set-remark') $('rm-input').value = el.dataset.value;
});

$('cart-modal').addEventListener('click', e => { if (e.target === $('cart-modal')) closeCartModal(); });
$('kandar-modal').addEventListener('click', e => { if (e.target === $('kandar-modal')) closeKandar(); });
$('kandar-modal').addEventListener('change', e => { if (e.target.matches('input[data-group]')) updateModifierValidity(); });
$('remark-modal').addEventListener('click', e => { if (e.target === $('remark-modal')) closeRemarkModal(); });

// A spoken line whose option group is still unanswered borrows the same dialog
// the menu uses, rather than a second one that would drift out of step with it.
document.addEventListener('voice-needs-options', e => openModifiers(e.detail.item, 'voice'));

init();
