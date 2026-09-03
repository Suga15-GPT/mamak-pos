import { $, fmt, esc, toast } from './state.js';

/* ===== KITCHEN ===== */
export async function refreshKitchen() {
  try {
    const orders = await API.get('/api/orders');
    const active = orders.filter(o => ['sent', 'preparing', 'ready'].includes(o.status)).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const served = orders.filter(o => o.status === 'served').sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    if (!active.length) { $('kitchen-active').innerHTML = '<div class="empty">No active orders</div>'; }
    else {
      $('kitchen-active').innerHTML = active.map(o => {
        const mins = Math.floor((Date.now() - new Date(o.created_at)) / 60000);
        return `<div class="k-order ${o.status}">
          <div class="head"><b>#${o.id} · ${esc(o.table)}</b>
            <span><span class="badge ${o.status}">${o.status}</span> <span class="badge" style="background:var(--charcoal)">${mins}m</span></span></div>
          <ul>${o.items.map(l => `<li><b>${l.qty}×</b> ${esc(l.name)}
            <small>${l.mods.map(m => m.name + (m.price ? ` +${fmt(m.price)}` : '')).join(' · ')}${l.note ? ` ·  ${esc(l.note)}` : ''}</small></li>`).join('')}</ul>
          <div class="k-actions">
            <button style="background:${o.status === 'sent' ? '#ea580c' : '#d4ccc6'}" data-action="set-status" data-id="${o.id}" data-status="preparing" ${o.status !== 'sent' ? 'disabled' : ''}> Cooking</button>
            <button style="background:${o.status === 'preparing' ? '#16a34a' : '#d4ccc6'}" data-action="set-status" data-id="${o.id}" data-status="ready" ${o.status !== 'preparing' ? 'disabled' : ''}>✅ Ready</button>
            <button style="background:${o.status === 'ready' ? '#7c3aed' : '#d4ccc6'}" data-action="set-status" data-id="${o.id}" data-status="served" ${o.status !== 'ready' ? 'disabled' : ''}>🍽 Served</button>
          </div></div>`;
      }).join('');
    }

    if (served.length) {
      $('kitchen-served').style.display = '';
      $('kitchen-served-list').innerHTML = served.map(o => {
        const mins = Math.floor((Date.now() - new Date(o.created_at)) / 60000);
        return `<div class="k-order served">
          <div class="head"><b>#${o.id} · ${esc(o.table)}</b>
            <span><span class="badge served">served</span> <span class="badge" style="background:var(--charcoal)">${mins}m</span></span></div>
          <ul>${o.items.map(l => `<li><b>${l.qty}×</b> ${esc(l.name)}</li>`).join('')}</ul>
        </div>`;
      }).join('');
    } else {
      $('kitchen-served').style.display = 'none';
    }
  } catch (e) { console.error(e); }
}

async function setSt(id, status) {
  try { await API.patch('/api/orders/' + id, { status }); refreshKitchen(); toast('Status updated'); } catch (e) { toast(e.message); }
}

$('tab-kitchen').addEventListener('click', e => {
  const el = e.target.closest('[data-action="set-status"]');
  if (!el) return;
  setSt(Number(el.dataset.id), el.dataset.status);
});
