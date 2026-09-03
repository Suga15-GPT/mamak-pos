import { $, fmt, esc, toast } from './state.js';

/* ===== ADMIN ===== */
export async function refreshAdmin() {
  try {
    const [allMenu, settings, qrTables, audit] = await Promise.all([
      API.get('/api/admin/menu'), API.get('/api/settings'), API.get('/api/admin/tables'), API.get('/api/admin/audit?limit=100')
    ]);
    $('tax-rate-input').value = (settings.tax_rate_bp / 100).toFixed(2);
    $('svc-rate-input').value = (settings.svc_rate_bp / 100).toFixed(2);

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
  try { await API.patch('/api/admin/items/' + id, { available: avail }); toast(avail ? 'Item available' : 'Item sold out'); } catch (e) { toast(e.message); }
}

async function toggleModAvail(id, avail) {
  try { await API.patch('/api/admin/modifier_options/' + id, { available: avail }); toast(avail ? 'Option available' : 'Option sold out'); } catch (e) { toast(e.message); }
}

async function saveRates() {
  const tax_rate_bp = Math.round(Number($('tax-rate-input').value) * 100);
  const svc_rate_bp = Math.round(Number($('svc-rate-input').value) * 100);
  if (!Number.isFinite(tax_rate_bp) || !Number.isFinite(svc_rate_bp)) return toast('Enter valid percentages');
  try { await API.patch('/api/settings', { tax_rate_bp, svc_rate_bp }); toast('Rates saved'); refreshAdmin(); }
  catch (e) { toast(e.message); }
}

$('tab-admin').addEventListener('change', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'toggle-avail') toggleAvail(Number(el.dataset.id), el.checked);
  else if (action === 'toggle-mod-avail') toggleModAvail(Number(el.dataset.id), el.checked);
});

$('tab-admin').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el && el.dataset.action === 'save-rates') saveRates();
});
