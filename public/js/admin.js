import { $, fmt, esc, toast } from './state.js';
import { refreshStaff } from './staff.js';

let lastMenu = null;

/* ===== ADMIN ===== */
export async function refreshAdmin() {
  try {
    const [allMenu, settings, qrTables, audit, printers, printJobs] = await Promise.all([
      API.get('/api/admin/menu'), API.get('/api/settings'), API.get('/api/admin/tables'), API.get('/api/admin/audit?limit=100'),
      API.get('/api/admin/printers'), API.get('/api/admin/print-jobs?limit=50'),
    ]);
    refreshStaff();
    lastMenu = allMenu;
    $('tax-rate-input').value = (settings.tax_rate_bp / 100).toFixed(2);
    $('svc-rate-input').value = (settings.svc_rate_bp / 100).toFixed(2);
    $('restaurant-name-input').value = settings.restaurant_name || '';
    $('restaurant-address-input').value = settings.restaurant_address || '';
    $('sst-number-input').value = settings.sst_number || '';

    $('admin-categories').innerHTML = allMenu.categories.map((c, i) => `
      <div class="admin-row">
        <div><b>${esc(c.name)}</b></div>
        <div style="display:flex;gap:4px">
          <button class="btn small outline" data-action="cat-move" data-id="${c.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn small outline" data-action="cat-move" data-id="${c.id}" data-dir="1" ${i === allMenu.categories.length - 1 ? 'disabled' : ''}>↓</button>
        </div>
      </div>`).join('');

    const groupsByItem = {};
    allMenu.item_modifier_groups.forEach(ig => { (groupsByItem[ig.item_id] ||= new Set()).add(ig.group_id); });

    $('admin-menu').innerHTML = allMenu.items.map((it, i) => {
      const attached = groupsByItem[it.id] || new Set();
      const chips = allMenu.modifier_groups.map(g => `
        <button class="btn small ${attached.has(g.id) ? '' : 'outline'}" data-action="toggle-item-group" data-item="${it.id}" data-group="${g.id}" data-attached="${attached.has(g.id)}">${esc(g.name)}</button>
      `).join('');
      return `
      <div class="admin-row">
        <div style="flex:1">
          <b>${esc(it.name)}</b>
          <div class="meta">${fmt(it.price_cents / 100)} · ${it.kandar ? 'Nasi Kandar' : 'Standard'}${it.sold_out_until ? ' · Sold out today' : ''}</div>
          <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">${chips || '<span class="meta">No modifier groups attached</span>'}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
          <div style="display:flex;gap:4px">
            <button class="btn small outline" data-action="item-move" data-id="${it.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn small outline" data-action="item-move" data-id="${it.id}" data-dir="1" ${i === allMenu.items.length - 1 ? 'disabled' : ''}>↓</button>
          </div>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--warm-gray)">
            <input type="checkbox" ${it.sold_out_until ? 'checked' : ''} data-action="toggle-sold-out-today" data-id="${it.id}"> Sold out today
          </label>
          <label class="switch" title="Sold out indefinitely"><input type="checkbox" ${it.available ? 'checked' : ''} data-action="toggle-avail" data-id="${it.id}"><span class="slider"></span></label>
        </div>
      </div>`;
    }).join('');

    $('admin-groups').innerHTML = allMenu.modifier_groups.map(g => `
      <div class="admin-row">
        <div style="flex:1"><b>${esc(g.name)}</b><div class="meta">${esc(g.mode)}</div></div>
        <div style="display:flex;align-items:center;gap:12px">
          <label style="font-size:12px;color:var(--warm-gray)">Min <input type="number" min="0" style="width:56px;color:var(--charcoal)" value="${g.min_select}" data-action="group-min" data-id="${g.id}"></label>
          <label style="font-size:12px;color:var(--warm-gray)">Max <input type="number" min="0" style="width:56px;color:var(--charcoal)" value="${g.max_select}" data-action="group-max" data-id="${g.id}"></label>
        </div>
      </div>`).join('');

    $('admin-modifiers').innerHTML = allMenu.modifier_options.map(o => `
      <div class="admin-row">
        <div><b>${esc(o.name)}</b><div class="meta">${o.price_cents > 0 ? '+' + fmt(o.price_cents / 100) : 'Free'} · ${allMenu.modifier_groups.find(g => g.id === o.group_id)?.name || ''}</div></div>
        <label class="switch"><input type="checkbox" ${o.available !== false ? 'checked' : ''} data-action="toggle-mod-avail" data-id="${o.id}"><span class="slider"></span></label>
      </div>`).join('');

    $('qr-grid').innerHTML = qrTables.map(t => `
      <div class="qr-card">
        <img id="qr-img-${t.id}" alt="${esc(t.name)}">
        <div style="font-weight:700;margin-top:8px">${esc(t.name)}</div>
        <a href="${t.url}" target="_blank">Open link</a>
      </div>`).join('');
    qrTables.forEach(t => {
      API.getBlobUrl(`/api/admin/tables/${t.id}/qr.png`)
        .then(url => { const img = $('qr-img-' + t.id); if (img) img.src = url; })
        .catch(() => {});
    });

    $('admin-printers').innerHTML = printers.map(pr => `
      <div class="admin-row">
        <div style="flex:1">
          <b>${esc(pr.name)}</b>
          <div class="meta">${esc(pr.host)}:${pr.port} · ${esc(pr.role)} · ${pr.width} chars/line</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <label class="switch" title="Enabled"><input type="checkbox" ${pr.enabled ? 'checked' : ''} data-action="toggle-printer-enabled" data-id="${pr.id}"><span class="slider"></span></label>
          <button class="btn small outline" data-action="test-print" data-id="${pr.id}">Test print</button>
          <button class="btn small outline" data-action="delete-printer" data-id="${pr.id}" style="color:var(--red)">Delete</button>
        </div>
      </div>`).join('') || '<div class="empty">No printers configured</div>';

    $('admin-print-jobs').innerHTML = printJobs.map(j => `
      <div class="admin-row">
        <div>
          <b>${esc(j.kind)}</b> · ${esc(j.printer_name || 'no printer')} ·
          <span style="color:${j.status === 'failed' ? 'var(--red)' : j.status === 'done' ? 'var(--sage-deep)' : 'var(--warm-gray)'}">${esc(j.status)}</span>
          <div class="meta">${new Date(j.created_at).toLocaleString()}${j.order_id != null ? ' · Order #' + j.order_id : ''}${j.attempts ? ' · ' + j.attempts + ' attempt(s)' : ''}${j.last_error ? ' · ' + esc(j.last_error) : ''}</div>
        </div>
      </div>`).join('') || '<div class="empty">No print jobs yet</div>';

    $('audit-log').innerHTML = audit.map(a => `
      <div class="admin-row">
        <div>
          <b>${esc(a.action)}</b> · ${esc(a.user_name || 'system')}
          <div class="meta">${new Date(a.at).toLocaleString()} · ${esc(a.entity_type)}${a.entity_id != null ? ' #' + a.entity_id : ''} · ${esc(JSON.stringify(a.detail))}</div>
        </div>
      </div>`).join('') || '<div class="empty">No activity yet</div>';
  } catch (e) { toast('Admin load error: ' + e.message); console.error(e); }
}

async function toggleAvail(id, avail) {
  try { await API.patch('/api/admin/items/' + id, { available: avail }); toast(avail ? 'Item available' : 'Item sold out indefinitely'); } catch (e) { toast(e.message); }
}

async function toggleModAvail(id, avail) {
  try { await API.patch('/api/admin/modifier_options/' + id, { available: avail }); toast(avail ? 'Option available' : 'Option sold out'); } catch (e) { toast(e.message); }
}

async function toggleSoldOutToday(id, on) {
  try { await API.patch('/api/admin/items/' + id, { sold_out_today: on }); toast(on ? 'Sold out for today' : 'Back on the menu'); refreshAdmin(); }
  catch (e) { toast(e.message); }
}

async function toggleItemGroup(itemId, groupId, attached) {
  try {
    if (attached) await API.del(`/api/admin/item_modifier_groups/${itemId}/${groupId}`);
    else await API.post('/api/admin/item_modifier_groups', { item_id: itemId, group_id: groupId });
    refreshAdmin();
  } catch (e) { toast(e.message); }
}

async function moveItem(id, dir) {
  if (!lastMenu) return;
  const items = [...lastMenu.items];
  const idx = items.findIndex(i => i.id === id);
  const swapIdx = idx + dir;
  if (idx < 0 || swapIdx < 0 || swapIdx >= items.length) return;
  [items[idx], items[swapIdx]] = [items[swapIdx], items[idx]];
  try {
    await Promise.all(items.map((it, i) => API.patch('/api/admin/items/' + it.id, { sort: i })));
    refreshAdmin();
  } catch (e) { toast(e.message); }
}

async function moveCategory(id, dir) {
  if (!lastMenu) return;
  const cats = [...lastMenu.categories];
  const idx = cats.findIndex(c => c.id === id);
  const swapIdx = idx + dir;
  if (idx < 0 || swapIdx < 0 || swapIdx >= cats.length) return;
  [cats[idx], cats[swapIdx]] = [cats[swapIdx], cats[idx]];
  try {
    await Promise.all(cats.map((c, i) => API.patch('/api/admin/categories/' + c.id, { sort: i })));
    refreshAdmin();
  } catch (e) { toast(e.message); }
}

async function updateGroupSelect(id, field, value) {
  const n = Math.max(0, parseInt(value) || 0);
  try { await API.patch('/api/admin/modifier_groups/' + id, { [field]: n }); toast('Saved'); } catch (e) { toast(e.message); }
}

async function createGroup() {
  const name = $('new-group-name').value.trim();
  const mode = $('new-group-mode').value;
  if (!name) return toast('Enter a group name');
  try { await API.post('/api/admin/modifier_groups', { name, mode }); $('new-group-name').value = ''; toast('Group created'); refreshAdmin(); }
  catch (e) { toast(e.message); }
}

async function saveRates() {
  const tax_rate_bp = Math.round(Number($('tax-rate-input').value) * 100);
  const svc_rate_bp = Math.round(Number($('svc-rate-input').value) * 100);
  if (!Number.isFinite(tax_rate_bp) || !Number.isFinite(svc_rate_bp)) return toast('Enter valid percentages');
  try { await API.patch('/api/settings', { tax_rate_bp, svc_rate_bp }); toast('Rates saved'); refreshAdmin(); }
  catch (e) { toast(e.message); }
}

// Phase 09: receipts and Z reports print these — an SST-registered business
// can't legally issue a receipt without its registration number on it.
async function saveRestaurantIdentity() {
  const restaurant_name = $('restaurant-name-input').value.trim();
  const restaurant_address = $('restaurant-address-input').value.trim();
  const sst_number = $('sst-number-input').value.trim();
  const tax_rate_bp = Math.round(Number($('tax-rate-input').value) * 100);
  const svc_rate_bp = Math.round(Number($('svc-rate-input').value) * 100);
  try {
    await API.patch('/api/settings', { tax_rate_bp, svc_rate_bp, restaurant_name, restaurant_address, sst_number });
    toast('Restaurant details saved');
    refreshAdmin();
  } catch (e) { toast(e.message); }
}

/* ===== printers (phase 08) ===== */
async function createPrinter() {
  const name = $('new-printer-name').value.trim();
  const host = $('new-printer-host').value.trim();
  const port = $('new-printer-port').value;
  const role = $('new-printer-role').value;
  const width = $('new-printer-width').value;
  if (!name || !host) return toast('Enter a name and host');
  try {
    await API.post('/api/admin/printers', { name, host, port, role, width });
    $('new-printer-name').value = ''; $('new-printer-host').value = ''; $('new-printer-port').value = '';
    toast('Printer added');
    refreshAdmin();
  } catch (e) { toast(e.message); }
}

async function togglePrinterEnabled(id, enabled) {
  try { await API.patch('/api/admin/printers/' + id, { enabled }); toast(enabled ? 'Printer enabled' : 'Printer disabled'); }
  catch (e) { toast(e.message); }
}

async function deletePrinter(id) {
  if (!confirm('Delete this printer?')) return;
  try { await API.del('/api/admin/printers/' + id); toast('Printer deleted'); refreshAdmin(); }
  catch (e) { toast(e.message); }
}

async function testPrintPrinter(id) {
  try { await API.post(`/api/admin/printers/${id}/test-print`, {}); toast('Test print queued'); refreshAdmin(); }
  catch (e) { toast('Test print failed: ' + e.message); }
}

$('tab-admin').addEventListener('change', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'toggle-avail') toggleAvail(Number(el.dataset.id), el.checked);
  else if (action === 'toggle-mod-avail') toggleModAvail(Number(el.dataset.id), el.checked);
  else if (action === 'toggle-sold-out-today') toggleSoldOutToday(Number(el.dataset.id), el.checked);
  else if (action === 'group-min') updateGroupSelect(Number(el.dataset.id), 'min_select', el.value);
  else if (action === 'group-max') updateGroupSelect(Number(el.dataset.id), 'max_select', el.value);
  else if (action === 'toggle-printer-enabled') togglePrinterEnabled(Number(el.dataset.id), el.checked);
});

$('tab-admin').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'save-rates') saveRates();
  else if (action === 'save-restaurant-identity') saveRestaurantIdentity();
  else if (action === 'item-move') moveItem(Number(el.dataset.id), Number(el.dataset.dir));
  else if (action === 'cat-move') moveCategory(Number(el.dataset.id), Number(el.dataset.dir));
  else if (action === 'toggle-item-group') toggleItemGroup(Number(el.dataset.item), Number(el.dataset.group), el.dataset.attached === 'true');
  else if (action === 'create-group') createGroup();
  else if (action === 'create-printer') createPrinter();
  else if (action === 'delete-printer') deletePrinter(Number(el.dataset.id));
  else if (action === 'test-print') testPrintPrinter(Number(el.dataset.id));
});
