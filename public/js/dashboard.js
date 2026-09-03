import { $, fmt, esc } from './state.js';

/* ===== DASHBOARD ===== */
export async function refreshDashboard() {
  try {
    const s = await API.get('/api/summary');
    $('dash-stats').innerHTML = `
      <div class="stat"><div class="v">${fmt(s.today.sales)}</div><div class="l">Today (${s.today.orders} orders)</div></div>
      <div class="stat"><div class="v">${fmt(s.month.sales)}</div><div class="l">This Month (${s.month.orders} orders)</div></div>
      <div class="stat"><div class="v">${fmt(s.year.sales)}</div><div class="l">This Year (${s.year.orders} orders)</div></div>
      <div class="stat"><div class="v">${s.open_orders}</div><div class="l">Open Orders</div></div>`;
    $('dash-top').innerHTML = s.top_items.length
      ? `<table style="width:100%;border-collapse:collapse;font-size:14px">${s.top_items.map(i => `<tr><td style="padding:8px 0;border-bottom:1px solid var(--light-gray)">${esc(i.name)}</td><td style="padding:8px 0;border-bottom:1px solid var(--light-gray);text-align:right;font-weight:700">${i.sold}</td></tr>`).join('')}</table>`
      : '<div class="empty">No sales today yet</div>';
  } catch (e) { console.error(e); }
}
