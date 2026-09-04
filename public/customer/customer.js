import { $, fmt, esc } from '../js/state.js';
import '../js/i18n.js';

let menu = { categories: [], items: [], modifier_groups: [], modifier_options: [] };
let tableToken = null, tableName = '', tableId = null;
let cart = [];
let activeCat = null;
let modItem = null;
let pendingItem = null;

async function init() {
  const parts = window.location.pathname.split('/');
  tableToken = parts[parts.length - 1];
  if (!tableToken || tableToken === 'customer.html') {
    $('loading').innerHTML = '<div style="color:var(--terra);font-weight:600">Invalid QR code</div><div>Please scan the QR at your table</div>';
    return;
  }
  try {
    const tInfo = await fetch('/api/t/' + tableToken).then(r => r.json());
    if (tInfo.error) { $('loading').innerHTML = '<div style="color:var(--terra);font-weight:600">Invalid table</div><div>Please ask staff for help</div>'; return; }
    tableName = tInfo.table.name; tableId = tInfo.table.id;
    $('table-name').textContent = tableName;

    menu = await fetch('/api/menu').then(r => r.json());
    activeCat = menu.categories[0]?.id;
    $('loading').style.display = 'none';
    $('app').style.display = '';
    renderCats(); renderItems(); updateBar();
  } catch (e) { $('loading').innerHTML = '<div style="color:var(--terra);font-weight:600">Failed to load</div><div>Check your connection and refresh</div>'; }
}

function renderCats() {
  $('menu-cats').innerHTML = menu.categories.map(c =>
    `<button class="${c.id === activeCat ? 'active' : ''}" data-action="set-cat" data-id="${c.id}">${esc(c.name)}</button>`
  ).join('');
}

function renderItems() {
  const items = menu.items.filter(i => i.category_id === activeCat);
  $('menu-items').innerHTML = items.map(it =>
    `<button class="item-btn" data-action="add-item" data-id="${it.id}">
      <div class="info">
        <div class="nm">${esc(it.name)}</div>
        ${(it.modifier_group_ids || []).length ? '<div class="customisable">Customisable</div>' : ''}
      </div>
      <div class="pr">${fmt(it.price)}</div>
    </button>`
  ).join('') || '<div class="empty">No items in this category</div>';
}

function addItem(id) {
  const it = menu.items.find(i => i.id === id);
  if (!it) return;
  if ((it.modifier_group_ids || []).length) { openModifiers(it); return; }

  const cat = menu.categories.find(c => c.id === it.category_id);
  const catName = cat ? cat.name.toLowerCase() : '';
  let presets = [];

  if (catName.includes('minuman') || catName.includes('drink')) {
    presets = ['Kurang manis', 'Less ice', 'No ice', 'Extra hot', 'Kurang kurang'];
  } else {
    presets = ['Kurang pedas', 'No onion', 'Extra spicy', 'No MSG', 'Kurang minyak'];
  }

  pendingItem = it;
  $('rm-title').textContent = it.name;
  $('rm-presets').innerHTML = presets.map(p =>
    `<button class="btn small outline" data-action="set-remark" data-value="${esc(p)}">${esc(p)}</button>`
  ).join('');
  $('rm-input').value = '';
  $('remark-modal').classList.add('show');
  setTimeout(() => $('rm-input').focus(), 100);
}

function skipRemark() {
  if (pendingItem) {
    const ex = cart.find(l => l.item_id === pendingItem.id && !l.mods.length && !l.note);
    if (ex) ex.qty++; else cart.push({ item_id: pendingItem.id, name: pendingItem.name, price: pendingItem.price, qty: 1, mods: [], note: '' });
    pendingItem = null;
  }
  closeRemarkModal(); updateBar();
}

function confirmRemark() {
  if (pendingItem) {
    const note = $('rm-input').value.trim();
    const ex = cart.find(l => l.item_id === pendingItem.id && !l.mods.length && l.note === note);
    if (ex) ex.qty++; else cart.push({ item_id: pendingItem.id, name: pendingItem.name, price: pendingItem.price, qty: 1, mods: [], note });
    pendingItem = null;
  }
  closeRemarkModal(); updateBar();
}

function closeRemarkModal() { $('remark-modal').classList.remove('show'); pendingItem = null; }

// Rendered entirely from the item's attached groups — nothing here is
// kandar-specific; `kandar` is display-only from phase 04 on.
function modifierGroupsFor(it) {
  return (it.modifier_group_ids || [])
    .map(gid => menu.modifier_groups.find(g => g.id === gid))
    .filter(Boolean);
}

function openModifiers(it) {
  modItem = it;
  $('km-title').textContent = it.name + ' — ' + fmt(it.price);
  let html = '';
  modifierGroupsFor(it).forEach(g => {
    const opts = menu.modifier_options.filter(o => o.group_id === g.id);
    const inputType = g.mode === 'radio' ? 'radio' : 'checkbox';
    const label = g.min_select > 0 ? `Choose ${g.min_select === g.max_select ? g.min_select : `${g.min_select}-${g.max_select}`} ${esc(g.name)}` : esc(g.name);
    html += `<div style="font-size:12px;color:var(--warm-gray);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin:18px 0 10px">${label}</div>`;
    html += opts.map(o => `<div class="mod-opt"><input type="${inputType}" name="grp-${g.id}" data-group="${g.id}" value="${o.id}"><span style="flex:1">${esc(o.name)}</span>${o.price ? `<span style="color:var(--terra);font-weight:700">+${fmt(o.price)}</span>` : ''}</div>`).join('');
  });
  $('km-body').innerHTML = html;
  $('km-remark').value = '';

  const presets = ['Kurang pedas', 'No onion', 'Extra spicy', 'Kurang minyak', 'Banjir sikit'];
  $('km-presets').innerHTML = presets.map(p =>
    `<button class="btn small outline" data-action="set-mod-remark" data-value="${esc(p)}">${esc(p)}</button>`
  ).join('');

  updateModifierValidity();
  $('kandar-modal').classList.add('show');
}

function updateModifierValidity() {
  const btn = $('km-confirm-btn');
  if (!modItem || !btn) return;
  const ok = modifierGroupsFor(modItem).every(g => {
    const count = document.querySelectorAll(`input[data-group="${g.id}"]:checked`).length;
    return count >= g.min_select && count <= g.max_select;
  });
  btn.disabled = !ok;
}

function closeKandar() { $('kandar-modal').classList.remove('show'); modItem = null; }

function confirmModifiers() {
  if (!modItem) return;
  const mods = [];
  modifierGroupsFor(modItem).forEach(g => {
    document.querySelectorAll(`input[data-group="${g.id}"]:checked`).forEach(inp => {
      const o = menu.modifier_options.find(x => x.id == inp.value);
      if (o) mods.push({ name: o.name, price: o.price });
    });
  });
  const note = $('km-remark').value.trim();
  cart.push({ item_id: modItem.id, name: modItem.name, price: modItem.price, qty: 1, mods, note });
  closeKandar(); updateBar();
}

function updateBar() {
  const count = cart.reduce((s, l) => s + l.qty, 0);
  const total = cart.reduce((s, l) => s + (l.price + l.mods.reduce((a, m) => a + m.price, 0)) * l.qty, 0);
  $('bar-count').textContent = count;
  $('bar-total').textContent = fmt(total);
  $('cart-bar').style.display = count ? '' : 'none';
}

function showCart() {
  if (!cart.length) { $('cart-lines').innerHTML = ''; $('cart-empty').style.display = ''; $('cart-totals').style.display = 'none'; }
  else {
    $('cart-empty').style.display = 'none'; $('cart-totals').style.display = '';
    let total = 0;
    $('cart-lines').innerHTML = cart.map((l, i) => {
      const lt = (l.price + l.mods.reduce((s, m) => s + m.price, 0)) * l.qty; total += lt;
      const ms = l.mods.map(m => m.name + (m.price ? ` +${fmt(m.price)}` : '')).join(', ');
      return `<div class="cart-line"><div><b>${l.qty}×</b> ${esc(l.name)}${ms ? `<br><small style="color:var(--warm-gray)">${esc(ms)}</small>` : ''}${l.note ? `<br><small style="color:var(--terra)">📝 ${esc(l.note)}</small>` : ''}</div>
        <div style="display:flex;align-items:center;gap:10px"><span style="font-weight:700;color:var(--terra)">${fmt(lt)}</span>
          <div class="qty"><button data-action="cart-qty" data-id="${i}" data-delta="-1">−</button><button data-action="cart-qty" data-id="${i}" data-delta="1">+</button><button data-action="cart-del" data-id="${i}" style="color:var(--red)">✕</button></div>
        </div></div>`;
    }).join('');
    $('cart-total-rm').textContent = fmt(total);
  }
  $('cart-modal').classList.add('show');
}

function closeCartModal() { $('cart-modal').classList.remove('show'); }
function cq(i, d) { cart[i].qty = Math.max(1, cart[i].qty + d); updateBar(); showCart(); }
function cd(i) { cart.splice(i, 1); updateBar(); showCart(); }

async function submitOrder() {
  if (!cart.length) return;
  $('submit-btn').disabled = true; $('submit-btn').textContent = 'Sending…';
  try {
    const items = cart.map(l => ({
      item_id: l.item_id, qty: l.qty, note: l.note, modifier_option_ids: l.mods.map(m => {
        const opt = menu.modifier_options.find(o => o.name === m.name); return opt ? opt.id : null;
      }).filter(Boolean)
    }));
    const r = await fetch('/api/public/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table_token: tableToken, items })
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 409) {
      // The table already has an open order — the public API has no way to
      // append to it (only staff/admin can, via an authenticated route), so
      // say so plainly rather than a generic failure.
      alert('This table already has an order with the kitchen. Please ask a staff member to add these items for you.');
      $('submit-btn').disabled = false; $('submit-btn').textContent = 'Place Order';
      return;
    }
    if (!r.ok) throw new Error(body.error || 'failed');

    $('success-status').textContent = 'Status: Sent to kitchen';
    $('success-items').innerHTML = cart.map(l => {
      const lt = (l.price + l.mods.reduce((s, m) => s + m.price, 0)) * l.qty;
      return `<div class="row"><span>${l.qty}× ${esc(l.name)}</span><span>${fmt(lt)}</span></div>`;
    }).join('');
    cart = [];
    $('cart-modal').classList.remove('show');
    $('app').style.display = 'none'; $('cart-bar').style.display = 'none';
    $('success-view').style.display = '';
  } catch (e) { alert('Failed to place order. Please try again or ask staff.'); $('submit-btn').disabled = false; $('submit-btn').textContent = 'Place Order'; }
}

/* ===== EVENT WIRING ===== */
document.body.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'set-cat') { activeCat = Number(el.dataset.id); renderCats(); renderItems(); }
  else if (action === 'add-item') addItem(Number(el.dataset.id));
  else if (action === 'show-cart') showCart();
  else if (action === 'close-cart-modal') closeCartModal();
  else if (action === 'submit-order') submitOrder();
  else if (action === 'cart-qty') cq(Number(el.dataset.id), Number(el.dataset.delta));
  else if (action === 'cart-del') cd(Number(el.dataset.id));
  else if (action === 'reload') location.reload();
  else if (action === 'close-mods') closeKandar();
  else if (action === 'confirm-mods') confirmModifiers();
  else if (action === 'set-mod-remark') $('km-remark').value = el.dataset.value;
  else if (action === 'skip-remark') skipRemark();
  else if (action === 'confirm-remark') confirmRemark();
  else if (action === 'set-remark') $('rm-input').value = el.dataset.value;
});

$('cart-modal').addEventListener('click', e => { if (e.target === $('cart-modal')) closeCartModal(); });
$('kandar-modal').addEventListener('click', e => { if (e.target === $('kandar-modal')) closeKandar(); });
$('kandar-modal').addEventListener('change', e => { if (e.target.matches('input[data-group]')) updateModifierValidity(); });
$('remark-modal').addEventListener('click', e => { if (e.target === $('remark-modal')) closeRemarkModal(); });

init();
