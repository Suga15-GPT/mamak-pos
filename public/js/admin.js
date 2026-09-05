import { $, fmt, esc, toast, ask } from './state.js';
import { refreshStaff } from './staff.js';

/* ===== ADMIN =====
   Eight small sections instead of one endless page. Each section loads what it
   needs; nothing here speaks database. A "modifier group" is a food option
   group, an "item" is a dish, and "sold out today" is a big button rather than
   a toggle the size of a grain of rice. */

let menuData = null;      // last GET /api/admin/menu
let tablesData = [];
let settings = null;
let menuFilterCat = 'all';
let menuSearch = '';
let activeSection = 'menu';

/* ===== section switching ===== */
function showSection(id) {
  activeSection = id;
  document.querySelectorAll('#admin-tabs button').forEach(b => b.classList.toggle('active', b.dataset.id === id));
  document.querySelectorAll('.admin-section').forEach(s => s.classList.toggle('active', s.id === `sec-${id}`));
  if (id === 'system') refreshSystem();
  if (id === 'printers') refreshPrintJobs();
}

export async function refreshAdmin() {
  try {
    const [menu, s, tables] = await Promise.all([
      API.get('/api/admin/menu'), API.get('/api/settings'), API.get('/api/admin/tables'),
    ]);
    menuData = menu; settings = s; tablesData = tables;
    renderMenuSection();
    renderGroups();
    renderCategories();
    renderSettingsForms();
    renderTablesSection();
    refreshStaff();
    refreshPrinters();
    refreshPrintJobs();
    renderAuditSummary();
    if (activeSection === 'system') refreshSystem();
  } catch (e) { toast('Admin load error: ' + e.message); console.error(e); }
}

/* ===== MENU ===== */
function renderMenuSection() {
  const cats = menuData.categories;
  $('menu-admin-cats').innerHTML =
    [`<button class="${menuFilterCat === 'all' ? 'active' : ''}" data-action="menu-filter" data-id="all">All</button>`]
      .concat(cats.map(c => `<button class="${menuFilterCat === String(c.id) ? 'active' : ''}" data-action="menu-filter" data-id="${c.id}">${esc(c.name)}</button>`))
      .join('');

  const groupsByItem = {};
  menuData.item_modifier_groups.forEach(ig => { (groupsByItem[ig.item_id] ||= []).push(ig.group_id); });
  const catName = id => cats.find(c => c.id === id)?.name || 'No category';

  const items = menuData.items.filter(it =>
    (menuFilterCat === 'all' || String(it.category_id) === menuFilterCat) &&
    (!menuSearch || it.name.toLowerCase().includes(menuSearch)));

  $('admin-menu').innerHTML = items.map(it => {
    const soldOutToday = !!it.sold_out_until;
    const attached = (groupsByItem[it.id] || [])
      .map(gid => menuData.modifier_groups.find(g => g.id === gid))
      .filter(Boolean);
    return `<div class="menu-admin-row">
      <div>
        <b>${esc(it.name)}</b>
        <div class="meta">${fmt(it.price_cents / 100)} · ${esc(catName(it.category_id))} · ${esc(it.station_name || 'Kitchen')}</div>
        <div class="chip-row">
          ${it.available ? '' : '<span class="chip danger">Off the menu</span>'}
          ${attached.length
            ? attached.map(g => `<span class="chip on">${esc(g.name)}</span>`).join('')
            : '<span class="chip">No food options</span>'}
        </div>
      </div>
      <div class="row-actions">
        <button class="soldout-btn ${soldOutToday ? 'sold-out' : 'available'}"
                data-action="toggle-sold-out" data-id="${it.id}" data-on="${soldOutToday}">
          ${soldOutToday ? '🚫 Sold out today' : '✅ Available'}
        </button>
        <button class="btn small outline" data-action="edit-item" data-id="${it.id}">✏️ Edit</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty">No items match. Try another category, or add one.</div>';
}

/* ===== ADD / EDIT ITEM ===== */
let editingItemId = null;
let editingItemGroups = new Set();

function openItemModal(id) {
  editingItemId = id;
  const it = id ? menuData.items.find(i => i.id === id) : null;
  $('item-modal-title').textContent = it ? 'Edit item' : 'Add item';
  $('item-name').value = it ? it.name : '';
  $('item-price').value = it ? (it.price_cents / 100).toFixed(2) : '';
  $('item-active').checked = it ? it.available : true;
  $('item-category').innerHTML = menuData.categories
    .map(c => `<option value="${c.id}" ${it && it.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  $('item-station').innerHTML = menuData.stations
    .map(s => `<option value="${esc(s.code)}" ${it && it.station_code === s.code ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  editingItemGroups = new Set(it
    ? menuData.item_modifier_groups.filter(ig => ig.item_id === it.id).map(ig => ig.group_id)
    : []);
  renderItemGroupChips();
  $('item-delete-btn').style.display = it ? '' : 'none';
  $('item-modal-err').textContent = '';
  $('item-modal').classList.add('show');
}

function renderItemGroupChips() {
  $('item-groups').innerHTML = menuData.modifier_groups.map(g =>
    `<button class="chip ${editingItemGroups.has(g.id) ? 'on' : ''}" data-action="toggle-item-group" data-id="${g.id}">
      ${editingItemGroups.has(g.id) ? '✓ ' : '＋ '}${esc(g.name)}</button>`).join('')
    || '<span class="meta">No food option groups yet — add one below the menu.</span>';
}

function closeItemModal() { $('item-modal').classList.remove('show'); editingItemId = null; }

async function saveItem() {
  const body = {
    name: $('item-name').value.trim(),
    price: Number($('item-price').value),
    category_id: Number($('item-category').value) || null,
    station_code: $('item-station').value,
    available: $('item-active').checked,
  };
  if (!body.name) { $('item-modal-err').textContent = 'Give the item a name'; return; }
  if (!(body.price >= 0)) { $('item-modal-err').textContent = 'Give the item a price'; return; }
  try {
    let id = editingItemId;
    if (id) await API.patch(`/api/admin/items/${id}`, body);
    else id = (await API.post('/api/admin/items', body)).id;

    // Attachments are diffed rather than rewritten, so an unchanged item makes
    // no calls at all.
    const before = new Set(menuData.item_modifier_groups.filter(ig => ig.item_id === id).map(ig => ig.group_id));
    for (const gid of editingItemGroups) if (!before.has(gid)) await API.post('/api/admin/item_modifier_groups', { item_id: id, group_id: gid });
    for (const gid of before) if (!editingItemGroups.has(gid)) await API.del(`/api/admin/item_modifier_groups/${id}/${gid}`);

    closeItemModal();
    toast('Saved');
    refreshAdmin();
  } catch (e) { $('item-modal-err').textContent = e.message; }
}

async function deleteItem() {
  const it = menuData.items.find(i => i.id === editingItemId);
  if (!it) return;
  if (!confirm(`Delete ${it.name}? Old bills keep their own copy of the name and price, so history is safe.`)) return;
  try { await API.del(`/api/admin/items/${editingItemId}`); closeItemModal(); toast('Deleted'); refreshAdmin(); }
  catch (e) { $('item-modal-err').textContent = e.message; }
}

async function toggleSoldOut(id, currentlyOn) {
  try {
    await API.patch(`/api/admin/items/${id}`, { sold_out_today: !currentlyOn });
    toast(currentlyOn ? 'Back on the menu' : 'Sold out for today — back automatically tomorrow');
    refreshAdmin();
  } catch (e) { toast(e.message); }
}

/* ===== FOOD OPTIONS =====
   Shown as what they are: a question and its answers, with what uses it. */
function renderGroups() {
  const attachedNames = {};
  menuData.item_modifier_groups.forEach(ig => {
    const item = menuData.items.find(i => i.id === ig.item_id);
    if (item) (attachedNames[ig.group_id] ||= []).push(item.name);
  });

  $('admin-groups').innerHTML = menuData.modifier_groups.map(g => {
    const opts = menuData.modifier_options.filter(o => o.group_id === g.id);
    const used = attachedNames[g.id] || [];
    return `<div class="opt-group">
      <div class="opt-group-head">
        <div>
          <div class="n">${esc(g.name)}</div>
          <div class="meta">Choose ${g.mode === 'radio' ? 'one' : 'several'} · minimum ${g.min_select} · maximum ${g.max_select}</div>
        </div>
        <div class="row-actions">
          <button class="btn small outline" data-action="edit-group" data-id="${g.id}">✏️ Edit group</button>
          <button class="btn small ghost" data-action="duplicate-group-card" data-id="${g.id}">⧉ Duplicate</button>
        </div>
      </div>
      <div class="opt-list">
        ${opts.map(o => `<span class="opt-pill${o.available ? '' : ' chip danger'}">${esc(o.name)}${o.price_cents ? ` <span class="p">+${fmt(o.price_cents / 100)}</span>` : ''}${o.available ? '' : ' · sold out'}</span>`).join('')
          || '<span class="chip warn">No options yet</span>'}
        <button class="chip" data-action="edit-group" data-id="${g.id}">＋ Add option</button>
      </div>
      <div class="meta" style="margin-top:10px">Asked on: ${used.length ? esc(used.slice(0, 6).join(', ')) + (used.length > 6 ? ` and ${used.length - 6} more` : '') : 'nothing yet'}</div>
    </div>`;
  }).join('') || '<div class="empty">No food option groups yet.</div>';
}

let editingGroupId = null;

function openGroupModal(id) {
  editingGroupId = id;
  const g = id ? menuData.modifier_groups.find(x => x.id === id) : null;
  $('group-modal-title').textContent = g ? 'Edit food options' : 'New food option group';
  $('group-name').value = g ? g.name : '';
  $('group-mode').value = g ? g.mode : 'checkbox';
  $('group-min').value = g ? g.min_select : 0;
  $('group-max').value = g ? g.max_select : 1;
  $('group-modal-err').textContent = '';
  $('group-delete-btn').style.display = g ? '' : 'none';
  $('group-duplicate-btn').style.display = g ? '' : 'none';
  renderGroupOptions();
  $('group-modal').classList.add('show');
}

function renderGroupOptions() {
  if (!editingGroupId) {
    $('group-options').innerHTML = '<p class="meta" style="margin-top:12px">Save the group first, then add its options.</p>';
    $('group-used-by').textContent = '';
    return;
  }
  const opts = menuData.modifier_options.filter(o => o.group_id === editingGroupId);
  $('group-options').innerHTML = `<div class="bill-group-head">Options</div>` + (opts.map((o, i) => `
    <div class="admin-row">
      <div style="flex:1"><b>${esc(o.name)}</b><div class="meta">${o.price_cents ? `+${fmt(o.price_cents / 100)}` : 'No extra charge'}</div></div>
      <div class="row-actions">
        <button class="btn small ghost" data-action="move-option" data-id="${o.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
        <button class="btn small ghost" data-action="move-option" data-id="${o.id}" data-dir="1" ${i === opts.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
        <button class="btn small outline" data-action="rename-option" data-id="${o.id}">Rename</button>
        <button class="btn small outline" data-action="price-option" data-id="${o.id}">Price</button>
        <button class="chip ${o.available ? 'sage' : 'danger'}" data-action="toggle-option-avail" data-id="${o.id}" data-on="${o.available}">
          ${o.available ? 'Available' : 'Sold out'}</button>
        <button class="btn-danger" data-action="delete-option" data-id="${o.id}">Delete</button>
      </div>
    </div>`).join('') || '<div class="meta" style="padding:10px 0">No options yet.</div>');

  const used = menuData.item_modifier_groups
    .filter(ig => ig.group_id === editingGroupId)
    .map(ig => menuData.items.find(i => i.id === ig.item_id)?.name).filter(Boolean);
  $('group-used-by').textContent = used.length ? `Used by: ${used.join(', ')}` : 'Not attached to any item yet.';
}

function closeGroupModal() { $('group-modal').classList.remove('show'); editingGroupId = null; }

async function saveGroup() {
  const body = {
    name: $('group-name').value.trim(),
    mode: $('group-mode').value,
    min_select: Number($('group-min').value) || 0,
    max_select: Number($('group-max').value) || 0,
  };
  if (!body.name) { $('group-modal-err').textContent = 'Give the group a name'; return; }
  if (body.max_select < body.min_select) { $('group-modal-err').textContent = 'Maximum cannot be less than minimum'; return; }
  try {
    // Create then patch: POST only takes a name and a mode (it derives the
    // sensible min/max for that mode), so the min/max typed here are applied
    // straight afterwards.
    if (!editingGroupId) editingGroupId = (await API.post('/api/admin/modifier_groups', { name: body.name, mode: body.mode })).id;
    await API.patch(`/api/admin/modifier_groups/${editingGroupId}`, body);
    menuData = await API.get('/api/admin/menu');
    renderGroups(); renderMenuSection(); renderGroupOptions();
    toast('Saved');
  } catch (e) { $('group-modal-err').textContent = e.message; }
}

async function duplicateGroup() {
  try {
    await API.post(`/api/admin/modifier_groups/${editingGroupId}/duplicate`, {});
    closeGroupModal(); toast('Duplicated'); refreshAdmin();
  } catch (e) { $('group-modal-err').textContent = e.message; }
}

async function deleteGroup() {
  const g = menuData.modifier_groups.find(x => x.id === editingGroupId);
  try {
    await API.del(`/api/admin/modifier_groups/${editingGroupId}`);
    closeGroupModal(); toast('Deleted'); refreshAdmin();
  } catch (e) {
    // The server refuses while the group is still attached to items, and names
    // them — repeat that to the admin and let them confirm knowingly.
    if (e.body?.needs_confirm) {
      if (!confirm(`${e.message}\n\nItems affected: ${e.body.attached_items.join(', ')}\n\nDelete anyway?`)) return;
      try {
        await API.request('DELETE', `/api/admin/modifier_groups/${editingGroupId}?confirm=1`);
        closeGroupModal(); toast(`${g?.name || 'Group'} deleted`); refreshAdmin();
      } catch (e2) { $('group-modal-err').textContent = e2.message; }
    } else $('group-modal-err').textContent = e.message;
  }
}

async function addOption() {
  const name = $('new-option-name').value.trim();
  const price = Number($('new-option-price').value || 0);
  if (!editingGroupId) { $('group-modal-err').textContent = 'Save the group first'; return; }
  if (!name) { $('group-modal-err').textContent = 'Give the option a name'; return; }
  try {
    await API.post('/api/admin/modifier_options', { group_id: editingGroupId, name, price });
    $('new-option-name').value = ''; $('new-option-price').value = '0';
    menuData = await API.get('/api/admin/menu');
    renderGroupOptions(); renderGroups();
  } catch (e) { $('group-modal-err').textContent = e.message; }
}

async function patchOption(id, body) {
  try {
    await API.patch(`/api/admin/modifier_options/${id}`, body);
    menuData = await API.get('/api/admin/menu');
    renderGroupOptions(); renderGroups();
  } catch (e) { toast(e.message); }
}

async function moveOption(id, dir) {
  const opts = menuData.modifier_options.filter(o => o.group_id === editingGroupId);
  const idx = opts.findIndex(o => o.id === id);
  const swap = idx + dir;
  if (idx < 0 || swap < 0 || swap >= opts.length) return;
  [opts[idx], opts[swap]] = [opts[swap], opts[idx]];
  try {
    for (const [i, o] of opts.entries()) await API.patch(`/api/admin/modifier_options/${o.id}`, { sort: i });
    menuData = await API.get('/api/admin/menu');
    renderGroupOptions();
  } catch (e) { toast(e.message); }
}

async function deleteOption(id) {
  const o = menuData.modifier_options.find(x => x.id === id);
  if (!confirm(`Delete "${o?.name}"? Old bills keep their own copy, so history is safe.`)) return;
  try {
    await API.del(`/api/admin/modifier_options/${id}`);
    menuData = await API.get('/api/admin/menu');
    renderGroupOptions(); renderGroups();
  } catch (e) { toast(e.message); }
}

/* ===== CATEGORIES ===== */
function renderCategories() {
  $('admin-categories').innerHTML = menuData.categories.map((c, i) => {
    const count = menuData.items.filter(it => it.category_id === c.id).length;
    return `<div class="admin-row">
      <div><b>${esc(c.name)}</b><div class="meta">${count} item${count === 1 ? '' : 's'}</div></div>
      <div class="row-actions">
        <button class="btn small ghost" data-action="cat-move" data-id="${c.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
        <button class="btn small ghost" data-action="cat-move" data-id="${c.id}" data-dir="1" ${i === menuData.categories.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
        <button class="btn small outline" data-action="rename-category" data-id="${c.id}">Rename</button>
        <button class="btn-danger" data-action="delete-category" data-id="${c.id}">Delete</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty">No categories yet.</div>';
}

async function newCategory() {
  const name = await ask({ title: 'New category', hint: 'For example: Nasi, Mee, Roti, Minuman.', ok: 'Add' });
  if (!name) return;
  try { await API.post('/api/admin/categories', { name }); toast('Category added'); refreshAdmin(); }
  catch (e) { toast(e.message); }
}

async function renameCategory(id) {
  const c = menuData.categories.find(x => x.id === id);
  const name = await ask({ title: 'Rename category', value: c?.name || '', ok: 'Rename' });
  if (!name) return;
  try { await API.patch(`/api/admin/categories/${id}`, { name }); toast('Renamed'); refreshAdmin(); }
  catch (e) { toast(e.message); }
}

async function deleteCategory(id) {
  const c = menuData.categories.find(x => x.id === id);
  if (!confirm(`Delete the category "${c?.name}"?`)) return;
  try { await API.del(`/api/admin/categories/${id}`); toast('Deleted'); refreshAdmin(); }
  catch (e) { toast(e.message); }
}

async function moveCategory(id, dir) {
  const cats = [...menuData.categories];
  const idx = cats.findIndex(c => c.id === id);
  const swap = idx + dir;
  if (idx < 0 || swap < 0 || swap >= cats.length) return;
  [cats[idx], cats[swap]] = [cats[swap], cats[idx]];
  try {
    for (const [i, c] of cats.entries()) await API.patch(`/api/admin/categories/${c.id}`, { sort: i });
    refreshAdmin();
  } catch (e) { toast(e.message); }
}

/* ===== TABLES & QR ===== */
function renderTablesSection() {
  $('qr-enabled-toggle').checked = settings.qr_ordering_enabled;
  $('qr-approval-select').value = settings.qr_require_approval ? 'approval' : 'direct';

  API.get('/api/admin/qr-health').then(h => {
    const problems = [...h.problems, ...h.warnings];
    $('qr-health').innerHTML = h.ok && !h.warnings.length
      ? `<div class="banner info">✅ QR links are working — <b>${esc(h.base_url)}</b></div>`
      : `<div class="banner ${h.ok ? 'warn' : 'danger'}">
           <div><b>${h.ok ? 'QR links need attention' : 'QR links will not work for customers'}</b>
           <div style="font-weight:500;margin-top:4px">${esc(h.base_url)}</div>
           ${problems.map(p => `<div style="font-weight:500;margin-top:4px">• ${esc(p)}</div>`).join('')}</div>
         </div>`;
  }).catch(() => {});

  $('qr-grid').innerHTML = tablesData.map(t => `
    <div class="qr-card${t.active ? '' : ' muted'}">
      <img id="qr-img-${t.id}" alt="QR code for ${esc(t.name)}">
      <div class="qr-name">${esc(t.name)}${t.active ? '' : ' <span class="chip danger">Retired</span>'}</div>
      <div class="qr-url">${esc(t.url)}</div>
      ${t.open_orders ? '<div class="chip warn" style="margin-top:6px">Order open</div>' : ''}
      <div class="qr-actions">
        <a class="btn small outline" href="${esc(t.url)}" target="_blank" rel="noopener">Open</a>
        <button class="btn small outline" data-action="copy-qr" data-id="${t.id}">Copy link</button>
        <button class="btn small outline" data-action="download-qr" data-id="${t.id}">Download</button>
        <button class="btn small outline" data-action="print-qr" data-id="${t.id}">Print</button>
        <button class="btn small outline" data-action="rename-table" data-id="${t.id}">Rename</button>
        ${t.active
          ? `<button class="btn-danger" data-action="retire-table" data-id="${t.id}">Retire</button>`
          : `<button class="btn small sage" data-action="restore-table" data-id="${t.id}">Bring back</button>`}
      </div>
    </div>`).join('') || '<div class="empty">No tables yet.</div>';

  tablesData.forEach(t => {
    API.getBlobUrl(`/api/admin/tables/${t.id}/qr.png`)
      .then(url => { const img = $('qr-img-' + t.id); if (img) { img.src = url; img.dataset.blob = url; } })
      .catch(() => {});
  });
}

async function copyQr(id) {
  const t = tablesData.find(x => x.id === id);
  try { await navigator.clipboard.writeText(t.url); toast('Link copied'); }
  catch { await ask({ title: 'Copy this link', value: t.url, ok: 'Done' }); }
}

function downloadQr(id) {
  const t = tablesData.find(x => x.id === id);
  const img = $('qr-img-' + id);
  if (!img?.dataset.blob) return toast('QR image is still loading');
  const a = document.createElement('a');
  a.href = img.dataset.blob;
  a.download = `qr-${t.name.replace(/\W+/g, '-').toLowerCase()}.png`;
  a.click();
}

// Prints a single QR at sticker size using a print-only region in this
// document — a popup window would be blocked, and writing into one would fall
// foul of the app's own Content-Security-Policy.
function printQr(id) {
  const t = tablesData.find(x => x.id === id);
  const img = $('qr-img-' + id);
  if (!img?.dataset.blob) return toast('QR image is still loading');
  let area = $('print-area');
  if (!area) {
    area = document.createElement('div');
    area.id = 'print-area';
    document.body.appendChild(area);
  }
  area.innerHTML = `<div class="print-qr">
    <h1>${esc(t.name)}</h1>
    <img src="${esc(img.dataset.blob)}" alt="">
    <p>Scan to see the menu and order</p>
    <small>${esc(t.url)}</small></div>`;
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); area.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

async function newTable() {
  const name = await ask({ title: 'Add a table', hint: 'What do staff call it? For example T13, or Booth 2.', ok: 'Add' });
  if (!name) return;
  try { await API.post('/api/admin/tables', { name }); toast('Table added'); refreshAdmin(); }
  catch (e) { toast(e.message); }
}

async function renameTable(id) {
  const t = tablesData.find(x => x.id === id);
  const name = await ask({ title: 'Rename table', value: t?.name || '', ok: 'Rename' });
  if (!name) return;
  try { await API.patch(`/api/admin/tables/${id}`, { name }); toast('Renamed'); refreshAdmin(); }
  catch (e) { toast(e.message); }
}

async function setTableActive(id, active) {
  const t = tablesData.find(x => x.id === id);
  if (!active && !confirm(`Retire ${t?.name}? Its QR stops working and it disappears from the floor. Old bills keep its name.`)) return;
  try { await API.patch(`/api/admin/tables/${id}`, { active }); toast(active ? 'Back in service' : 'Retired'); refreshAdmin(); }
  catch (e) { toast(e.message); }
}

async function setQrSetting(body, message) {
  try { await API.patch('/api/settings', body); settings = await API.get('/api/settings'); toast(message); }
  catch (e) { toast(e.message); refreshAdmin(); }
}

/* ===== RESTAURANT / TAX ===== */
function renderSettingsForms() {
  $('tax-rate-input').value = (settings.tax_rate_bp / 100).toFixed(2);
  $('svc-rate-input').value = (settings.svc_rate_bp / 100).toFixed(2);
  $('restaurant-name-input').value = settings.restaurant_name || '';
  $('restaurant-address-input').value = settings.restaurant_address || '';
  $('sst-number-input').value = settings.sst_number || '';
}

async function saveRates() {
  const tax_rate_bp = Math.round(Number($('tax-rate-input').value) * 100);
  const svc_rate_bp = Math.round(Number($('svc-rate-input').value) * 100);
  if (!Number.isFinite(tax_rate_bp) || !Number.isFinite(svc_rate_bp)) return toast('Enter valid percentages');
  try { await API.patch('/api/settings', { tax_rate_bp, svc_rate_bp }); toast('Saved'); refreshAdmin(); }
  catch (e) { toast(e.message); }
}

async function saveRestaurantIdentity() {
  try {
    await API.patch('/api/settings', {
      restaurant_name: $('restaurant-name-input').value.trim(),
      restaurant_address: $('restaurant-address-input').value.trim(),
      sst_number: $('sst-number-input').value.trim(),
    });
    toast('Saved');
    refreshAdmin();
  } catch (e) { toast(e.message); }
}

/* ===== PRINTERS ===== */
const PRINTER_ROLE_NAMES = { kitchen: 'Kitchen', receipt: 'Receipts', bar: 'Drinks / bar' };

async function refreshPrinters() {
  try {
    const printers = await API.get('/api/admin/printers');
    $('admin-printers').innerHTML = printers.map(pr => `
      <div class="admin-row">
        <div style="flex:1">
          <b>${esc(pr.name)}</b>
          <div class="meta">${esc(pr.host)}:${pr.port} · ${esc(PRINTER_ROLE_NAMES[pr.role] || pr.role)} · ${pr.width} characters per line</div>
        </div>
        <div class="row-actions">
          <label class="switch" title="Enabled"><input type="checkbox" ${pr.enabled ? 'checked' : ''} data-action="toggle-printer-enabled" data-id="${pr.id}"><span class="slider"></span></label>
          <button class="btn small outline" data-action="test-print" data-id="${pr.id}">Test print</button>
          <button class="btn-danger" data-action="delete-printer" data-id="${pr.id}">Delete</button>
        </div>
      </div>`).join('') || '<div class="empty">No printers configured. Chits and receipts will be recorded as failed until one is added.</div>';
  } catch (e) { /* section may not be visible */ }
}

const JOB_KIND_NAMES = { chit: 'Kitchen chit', receipt: 'Receipt', void: 'Void slip', report: 'Report' };

async function refreshPrintJobs() {
  try {
    const jobs = await API.get('/api/admin/print-jobs?limit=50');
    $('admin-print-jobs').innerHTML = jobs.map(j => {
      const where = [j.order_label && `${j.order_label}`, j.round && `Round ${j.round}`, j.station_name].filter(Boolean).join(' · ');
      const icon = j.status === 'failed' ? '🔴' : j.status === 'done' ? '🟢' : '⏳';
      return `<div class="admin-row">
        <div style="flex:1">
          <b>${icon} ${esc(JOB_KIND_NAMES[j.kind] || j.kind)}</b>${j.retry_of ? ' <span class="chip">reprint</span>' : ''}
          <div class="meta">${where ? esc(where) + ' · ' : ''}${esc(j.printer_name || 'no printer')} · ${new Date(j.created_at).toLocaleString()}</div>
          ${j.last_error ? `<div class="meta" style="color:var(--red)">${esc(j.last_error)}</div>` : ''}
        </div>
        ${j.status === 'failed' ? `<button class="btn small" data-action="retry-job" data-id="${j.id}">🖨 Retry</button>` : ''}
      </div>`;
    }).join('') || '<div class="empty">No print jobs yet</div>';
  } catch (e) { /* section may not be visible */ }
}

async function retryJob(id) {
  try { await API.post(`/api/admin/print-jobs/${id}/retry`, {}); toast('Reprint queued'); refreshPrintJobs(); }
  catch (e) { toast(e.message); }
}

async function createPrinter() {
  const name = $('new-printer-name').value.trim();
  const host = $('new-printer-host').value.trim();
  if (!name || !host) return toast('Enter a name and a host');
  try {
    await API.post('/api/admin/printers', {
      name, host, port: $('new-printer-port').value,
      role: $('new-printer-role').value, width: $('new-printer-width').value,
    });
    ['new-printer-name', 'new-printer-host', 'new-printer-port'].forEach(id => { $(id).value = ''; });
    toast('Printer added');
    refreshPrinters();
  } catch (e) { toast(e.message); }
}

/* ===== SYSTEM ===== */
function healthItem(dot, name, detail) {
  return `<div class="health-item"><span class="dot">${dot}</span>
    <div><div class="h-name">${esc(name)}</div><div class="h-detail">${detail}</div></div></div>`;
}

async function refreshSystem() {
  $('system-health').innerHTML = '<div class="empty">Checking…</div>';
  try {
    const h = await API.get('/api/admin/system');
    const rows = [];
    rows.push(healthItem(h.database.ok ? '🟢' : '🔴', 'Database',
      h.database.ok ? `Connected · ${h.database.latency_ms} ms` : esc(h.database.detail)));
    rows.push(healthItem('🟢', 'Live updates', `${h.realtime.connected_screens} screen${h.realtime.connected_screens === 1 ? '' : 's'} connected`));
    rows.push(healthItem(h.kitchen.late ? '🟠' : '🟢', 'Kitchen',
      `${h.kitchen.active} ticket${h.kitchen.active === 1 ? '' : 's'} in progress${h.kitchen.late ? ` · ${h.kitchen.late} over 10 minutes` : ''}`));

    if (!h.printing.printers.length) {
      rows.push(healthItem('🔴', 'Printers', 'None configured — chits and receipts are being recorded as failed'));
    } else {
      h.printing.printers.forEach(p => rows.push(healthItem(
        p.reachable === null ? '⏸' : p.reachable ? '🟢' : '🔴',
        `${p.name} (${PRINTER_ROLE_NAMES[p.role] || p.role})`,
        p.reachable === null ? 'Disabled'
          : p.reachable ? `Online at ${esc(p.host)}:${p.port}`
          : `Offline — ${esc(p.error || 'no answer')}`)));
    }
    if (h.printing.failed_jobs) {
      rows.push(healthItem('🔴', 'Failed print jobs',
        `${h.printing.failed_jobs} waiting — retry them under Printers → Print jobs`));
    }

    rows.push(healthItem(h.qr_url.ok ? '🟢' : '🔴', 'QR public address',
      h.qr_url.ok ? esc(h.qr_url.base_url) : h.qr_url.problems.map(esc).join(' ')));
    rows.push(healthItem(h.qr_ordering.enabled ? '🟢' : '⏸', 'QR ordering',
      h.qr_ordering.enabled
        ? (h.qr_ordering.approval_required ? 'On — each order waits for staff approval' : 'On — orders go straight to the kitchen')
        : 'Paused — customers are asked to order with staff'));

    rows.push(healthItem(h.backup.at ? (h.backup.ok ? '🟢' : '🟠') : '🔴', 'Last backup',
      h.backup.at
        ? `${new Date(h.backup.at).toLocaleString()} (${h.backup.age_hours} hours ago)${h.backup.note ? ` · ${esc(h.backup.note)}` : ''}`
        : 'No backup has ever reported in'));
    rows.push(healthItem(h.backup.off_device.configured ? '🟢' : '🟠', 'Off-device backup',
      h.backup.off_device.configured
        ? `Configured — ${esc(h.backup.off_device.target_kind)}`
        : 'Not configured. Backups live only on this machine, so losing it loses them too.'));

    if (h.disk) {
      rows.push(healthItem(h.disk.ok ? '🟢' : '🔴', 'Disk space',
        `${h.disk.free_percent}% free (${(h.disk.free_bytes / 1e9).toFixed(1)} GB of ${(h.disk.total_bytes / 1e9).toFixed(1)} GB)`));
    }
    rows.push(healthItem('ℹ️', 'Application',
      `Version ${esc(h.version)} · running for ${Math.floor(h.uptime_seconds / 3600)}h ${Math.floor((h.uptime_seconds % 3600) / 60)}m`));

    $('system-health').innerHTML = `<div class="health-grid">${rows.join('')}</div>
      <div class="meta" style="margin-top:12px">Checked ${new Date(h.checked_at).toLocaleTimeString()}</div>`;
  } catch (e) {
    $('system-health').innerHTML = `<div class="banner danger">Could not read system status: ${esc(e.message)}</div>`;
  }
}

/* ===== ACTIVITY =====
   Collapsed by default, and written as sentences. Raw JSON is available behind
   a disclosure for whoever actually needs it. */
const ACTION_WORDS = {
  'order.create': 'Started an order',
  'order.append': 'Sent an add-on to the kitchen',
  'order.status': 'Changed an order status',
  'order.cancel': 'Cancelled an order',
  'order.pay': 'Took a payment',
  'order.settle': 'Closed an order',
  'order.void_line': 'Voided an item',
  'order.refund': 'Issued a refund',
  'order.move': 'Moved an order to another table',
  'round.status': 'Moved a kitchen round along',
  'round.approve': 'Accepted a customer order',
  'round.reject': 'Rejected a customer order',
  'discount.apply': 'Applied a discount',
  'discount.remove': 'Removed a discount',
  'receipt.reprint': 'Reprinted a receipt',
  'print.retry': 'Retried a failed print',
  'shift.open': 'Opened a shift', 'shift.close': 'Closed a shift',
  'user.create': 'Added a staff member', 'user.update': 'Updated a staff member',
  'user.deactivate': 'Deactivated a staff member', 'user.pin_reset': 'Reset a PIN',
  'table.create': 'Added a table', 'table.update': 'Updated a table',
  'menu.item_create': 'Added a menu item', 'menu.item_update': 'Edited a menu item',
  'menu.item_delete': 'Deleted a menu item', 'menu.category_delete': 'Deleted a category',
  'menu.group_delete': 'Deleted a food option group', 'menu.option_delete': 'Deleted a food option',
};

function auditContext(a) {
  const d = a.detail || {};
  const bits = [];
  if (d.to_table) bits.push(`to ${d.to_table}`);
  if (a.entity_type === 'order' && a.entity_id) bits.push(`Order #${a.entity_id}`);
  if (d.round) bits.push(`Round ${d.round}`);
  if (d.name) bits.push(d.name);
  if (d.reason) bits.push(`“${d.reason}”`);
  if (d.amount_cents != null) bits.push(fmt(d.amount_cents / 100));
  if (d.method) bits.push(d.method);
  if (d.from && d.to) bits.push(`${d.from} → ${d.to}`);
  return bits.join(' · ');
}

let auditLoaded = false;
async function renderAuditSummary() {
  try {
    const rows = await API.get('/api/admin/audit?limit=1');
    $('audit-last').textContent = rows[0]
      ? `Last activity: ${new Date(rows[0].at).toLocaleTimeString()}`
      : 'No activity yet';
  } catch (e) { /* section may not be visible */ }
}

async function toggleAudit() {
  const el = $('audit-log');
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  el.style.display = '';
  if (auditLoaded) return;
  try {
    const rows = await API.get('/api/admin/audit?limit=150');
    el.innerHTML = rows.map(a => `
      <div class="admin-row">
        <div style="flex:1">
          <b>${esc(new Date(a.at).toLocaleTimeString())} · ${esc(a.user_name || 'System')}</b>
          <div class="meta">${esc(ACTION_WORDS[a.action] || a.action)}${auditContext(a) ? ' — ' + esc(auditContext(a)) : ''}</div>
          <details><summary class="meta" style="cursor:pointer;min-height:32px">Technical details</summary>
            <div class="meta" style="word-break:break-all">${esc(a.action)} · ${esc(a.entity_type)} #${a.entity_id ?? '-'} · ${esc(JSON.stringify(a.detail))}</div>
          </details>
        </div>
      </div>`).join('') || '<div class="empty">No activity yet</div>';
    auditLoaded = true;
  } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/* ===== EVENT WIRING ===== */
$('tab-admin').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const id = Number(el.dataset.id);
  const map = {
    'admin-section': () => showSection(el.dataset.id),
    'menu-filter': () => { menuFilterCat = el.dataset.id; renderMenuSection(); },
    'new-item': () => openItemModal(null),
    'edit-item': () => openItemModal(id),
    'toggle-sold-out': () => toggleSoldOut(id, el.dataset.on === 'true'),
    'new-category': newCategory,
    'rename-category': () => renameCategory(id),
    'delete-category': () => deleteCategory(id),
    'cat-move': () => moveCategory(id, Number(el.dataset.dir)),
    'new-group': () => openGroupModal(null),
    'edit-group': () => openGroupModal(id),
    'duplicate-group-card': async () => {
      try { await API.post(`/api/admin/modifier_groups/${id}/duplicate`, {}); toast('Duplicated'); refreshAdmin(); }
      catch (e) { toast('Could not duplicate: ' + e.message); }
    },
    'new-table': newTable,
    'rename-table': () => renameTable(id),
    'retire-table': () => setTableActive(id, false),
    'restore-table': () => setTableActive(id, true),
    'copy-qr': () => copyQr(id),
    'download-qr': () => downloadQr(id),
    'print-qr': () => printQr(id),
    'save-rates': saveRates,
    'save-restaurant-identity': saveRestaurantIdentity,
    'create-printer': createPrinter,
    'delete-printer': () => deletePrinter(id),
    'test-print': () => testPrintPrinter(id),
    'retry-job': () => retryJob(id),
    'refresh-print-jobs': refreshPrintJobs,
    'refresh-system': refreshSystem,
    'toggle-audit': toggleAudit,
  };
  if (map[a]) map[a]();
});

$('tab-admin').addEventListener('change', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'toggle-printer-enabled') togglePrinterEnabled(Number(el.dataset.id), el.checked);
  else if (a === 'toggle-qr-enabled') setQrSetting({ qr_ordering_enabled: el.checked },
    el.checked ? 'Customers can order again' : 'QR ordering paused');
  else if (a === 'set-qr-approval') setQrSetting({ qr_require_approval: el.value === 'approval' },
    el.value === 'approval' ? 'Customer orders now wait for staff' : 'Customer orders go straight to the kitchen');
});

$('menu-admin-search').addEventListener('input', e => { menuSearch = e.target.value.trim().toLowerCase(); renderMenuSection(); });

$('item-modal').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) { if (e.target === $('item-modal')) closeItemModal(); return; }
  const a = el.dataset.action;
  if (a === 'close-item-modal') closeItemModal();
  else if (a === 'save-item') saveItem();
  else if (a === 'delete-item') deleteItem();
  else if (a === 'toggle-item-group') {
    const gid = Number(el.dataset.id);
    editingItemGroups.has(gid) ? editingItemGroups.delete(gid) : editingItemGroups.add(gid);
    renderItemGroupChips();
  }
});

$('group-modal').addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) { if (e.target === $('group-modal')) closeGroupModal(); return; }
  const a = el.dataset.action;
  const id = Number(el.dataset.id);
  if (a === 'close-group-modal') closeGroupModal();
  else if (a === 'save-group') saveGroup();
  else if (a === 'duplicate-group') duplicateGroup();
  else if (a === 'delete-group') deleteGroup();
  else if (a === 'add-option') addOption();
  else if (a === 'toggle-option-avail') patchOption(id, { available: el.dataset.on !== 'true' });
  else if (a === 'move-option') moveOption(id, Number(el.dataset.dir));
  else if (a === 'delete-option') deleteOption(id);
  else if (a === 'rename-option') {
    const o = menuData.modifier_options.find(x => x.id === id);
    const name = await ask({ title: 'Rename option', value: o?.name || '', ok: 'Rename' });
    if (name) patchOption(id, { name });
  } else if (a === 'price-option') {
    const o = menuData.modifier_options.find(x => x.id === id);
    const price = await ask({ title: 'Extra charge (RM)', hint: 'Use 0 for no extra charge.', value: String((o?.price_cents || 0) / 100), ok: 'Save' });
    if (price !== null) patchOption(id, { price: Number(price) || 0 });
  }
});

async function togglePrinterEnabled(id, enabled) {
  try { await API.patch('/api/admin/printers/' + id, { enabled }); toast(enabled ? 'Printer on' : 'Printer off'); }
  catch (e) { toast(e.message); }
}
async function deletePrinter(id) {
  if (!confirm('Delete this printer?')) return;
  try { await API.del('/api/admin/printers/' + id); toast('Printer deleted'); refreshPrinters(); }
  catch (e) { toast(e.message); }
}
async function testPrintPrinter(id) {
  try { await API.post(`/api/admin/printers/${id}/test-print`, {}); toast('Test print queued'); refreshPrintJobs(); }
  catch (e) { toast('Test print failed: ' + e.message); }
}
