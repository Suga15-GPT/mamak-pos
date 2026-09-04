import { $, fmt, esc, toast, onStreamEvent } from './state.js';

// Void ids we've already flashed once, so a later poll/stream refresh doesn't
// replay the animation for a void the cook has already seen.
const flashedVoids = new Set();
// orderId -> the status to revert to if "Undo" is tapped within the window.
// Phase 03 already added backward transitions server-side; this just
// surfaces the existing one as a 5s undo instead of a manual status menu —
// note it 403s for the 'kitchen' role specifically (BACKWARD is blocked for
// that role by design), so Undo only works for admin/staff here.
const recentAdvance = new Map();
const UNDO_WINDOW_MS = 5000;

function ageBadgeClass(mins) {
  return mins < 5 ? 'age-fresh' : mins < 10 ? 'age-warm' : 'age-late';
}

/* ===== KITCHEN ===== */
export async function refreshKitchen() {
  try {
    const orders = await API.get('/api/orders');
    let active = orders.filter(o => ['sent', 'preparing', 'ready'].includes(o.status));
    const served = orders.filter(o => o.status === 'served').sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    // A ticket with a void the cook hasn't seen yet flashes once and sits at
    // the top of the list — that's the whole point of a void, catching it
    // before the wrong dish goes out.
    const newlyVoided = new Set();
    active.forEach(o => {
      o.items.forEach(l => {
        if (!l.voided) return;
        const key = `${o.id}:${l.id}`;
        if (!flashedVoids.has(key)) { flashedVoids.add(key); newlyVoided.add(o.id); }
      });
    });
    active = active.slice().sort((a, b) => {
      const av = a.items.some(i => i.voided), bv = b.items.some(i => i.voided);
      if (av !== bv) return av ? -1 : 1;
      return new Date(a.created_at) - new Date(b.created_at);
    });

    if (!active.length) { $('kitchen-active').innerHTML = '<div class="empty">No active orders</div>'; }
    else {
      $('kitchen-active').innerHTML = active.map(o => {
        const mins = Math.floor((Date.now() - new Date(o.created_at)) / 60000);
        const hasVoid = o.items.some(i => i.voided);
        const undo = recentAdvance.get(o.id);
        return `<div class="k-order ${o.status}${hasVoid ? ' has-void' : ''}${newlyVoided.has(o.id) ? ' void-flash' : ''}">
          <div class="head"><b>#${o.id} · ${esc(o.table)}</b>
            <span><span class="badge ${o.status}">${o.status}</span> <span class="badge ${ageBadgeClass(mins)}">${mins}m</span>${hasVoid ? ' <span class="badge void">VOID</span>' : ''}</span></div>
          <ul>${o.items.map(l => `<li${l.voided ? ' style="opacity:.5;text-decoration:line-through"' : ''}><b>${l.qty}×</b> ${esc(l.name)}${l.voided ? ' <b style="color:#dc2626;text-decoration:none">VOID</b>' : ''}
            <small>${l.mods.map(m => m.name + (m.price ? ` +${fmt(m.price)}` : '')).join(' · ')}${l.note ? ` ·  ${esc(l.note)}` : ''}</small></li>`).join('')}</ul>
          <div class="k-actions">
            <button style="background:${o.status === 'sent' ? '#ea580c' : '#d4ccc6'}" data-action="set-status" data-id="${o.id}" data-status="preparing" ${o.status !== 'sent' ? 'disabled' : ''}> Cooking</button>
            <button style="background:${o.status === 'preparing' ? '#16a34a' : '#d4ccc6'}" data-action="set-status" data-id="${o.id}" data-status="ready" ${o.status !== 'preparing' ? 'disabled' : ''}>✅ Ready</button>
            <button style="background:${o.status === 'ready' ? '#7c3aed' : '#d4ccc6'}" data-action="set-status" data-id="${o.id}" data-status="served" ${o.status !== 'ready' ? 'disabled' : ''}>🍽 Served</button>
          </div>
          ${undo ? `<button class="k-undo" data-action="undo-status" data-id="${o.id}">↶ Undo (5s)</button>` : ''}
          </div>`;
      }).join('');
    }

    if (served.length) {
      $('kitchen-served').style.display = '';
      $('kitchen-served-list').innerHTML = served.map(o => {
        const mins = Math.floor((Date.now() - new Date(o.created_at)) / 60000);
        return `<div class="k-order served">
          <div class="head"><b>#${o.id} · ${esc(o.table)}</b>
            <span><span class="badge served">served</span> <span class="badge ${ageBadgeClass(mins)}">${mins}m</span></span></div>
          <ul>${o.items.map(l => `<li><b>${l.qty}×</b> ${esc(l.name)}</li>`).join('')}</ul>
        </div>`;
      }).join('');
    } else {
      $('kitchen-served').style.display = 'none';
    }
  } catch (e) { console.error(e); }
}

async function setSt(id, status) {
  // Capture the status this order is *leaving* so a 5s "Undo" can send it
  // straight back — the PATCH below has already taken effect by the time
  // Undo is offered, matching the usual "undo toast" pattern.
  const orders = await API.get('/api/orders').catch(() => []);
  const prevStatus = orders.find(o => o.id === id)?.status;
  try {
    await API.patch('/api/orders/' + id, { status });
    if (prevStatus) {
      clearTimeout(recentAdvance.get(id)?.timer);
      const timer = setTimeout(() => { recentAdvance.delete(id); refreshKitchen(); }, UNDO_WINDOW_MS);
      recentAdvance.set(id, { prevStatus, timer });
    }
    refreshKitchen();
    toast('Status updated');
  } catch (e) { toast(e.message); }
}

async function undoStatus(id) {
  const entry = recentAdvance.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  recentAdvance.delete(id);
  try {
    await API.patch('/api/orders/' + id, { status: entry.prevStatus });
    toast('Undone');
  } catch (e) {
    // The 'kitchen' role is blocked from backward transitions server-side
    // (phase 03) — fail loudly rather than silently doing nothing.
    toast(e.status === 403 ? 'Undo needs a staff/admin login on this screen' : e.message);
  }
  refreshKitchen();
}

$('tab-kitchen').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'set-status') setSt(Number(el.dataset.id), el.dataset.status);
  else if (el.dataset.action === 'undo-status') undoStatus(Number(el.dataset.id));
});

/* Realtime: refresh the kitchen ticket the moment an order changes, without
   waiting for the 3s poll — this is the screen latency is felt on most. */
onStreamEvent(() => {
  if (document.getElementById('tab-kitchen')?.classList.contains('active')) refreshKitchen();
});
