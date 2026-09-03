import { $, fmt, esc, toast } from './state.js';

/* ===== ADMIN ===== */
export async function refreshAdmin() {
  try {
    const [allMenu, settings, qrTables] = await Promise.all([
      API.get('/api/admin/menu'), API.get('/api/settings'), API.get('/api/admin/tables')
    ]);
    $('sst-toggle').checked = settings.sst_on;
    $('sst-label').textContent = settings.sst_on ? 'SST (8%) is ON' : 'SST (8%) is OFF';

    $('admin-menu').innerHTML = allMenu.items.map(it => `
      <div class="admin-row">
        <div><b>${esc(it.name)}</b><div class="meta">${fmt(it.price_cents / 100)} · ${it.kandar ? 'Nasi Kandar' : 'Standard'}</div></div>
        <label class="switch"><input type="checkbox" ${it.available ? 'checked' : ''} data-action="toggle-avail" data-id="${it.id}"><span class="slider"></span></label>
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
  } catch (e) { toast('Admin load error: ' + e.message); console.error(e); }
}

async function toggleAvail(id, avail) {
  try { await API.patch('/api/admin/items/' + id, { available: avail }); toast(avail ? 'Item available' : 'Item sold out'); } catch (e) { toast(e.message); }
}

async function toggleModAvail(id, avail) {
  try { await API.patch('/api/admin/modifier_options/' + id, { available: avail }); toast(avail ? 'Option available' : 'Option sold out'); } catch (e) { toast(e.message); }
}

async function toggleSST() {
  try { await API.patch('/api/settings', { sst_on: $('sst-toggle').checked }); refreshAdmin(); } catch (e) { toast(e.message); }
}

$('tab-admin').addEventListener('change', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'toggle-avail') toggleAvail(Number(el.dataset.id), el.checked);
  else if (action === 'toggle-mod-avail') toggleModAvail(Number(el.dataset.id), el.checked);
});

$('sst-toggle').addEventListener('change', toggleSST);
