import { $, fmt, esc, toast } from './state.js';

// Cashiers count physical notes/coins, not a single number — the denomination
// counter totals as they type instead of asking for one lump "counted" figure.
const DENOMS = [
  [10000, 'RM 100'], [5000, 'RM 50'], [2000, 'RM 20'], [1000, 'RM 10'],
  [500, 'RM 5'], [100, 'RM 1'], [50, '50 sen'], [20, '20 sen'], [10, '10 sen'], [5, '5 sen'],
];

let currentShift = null;
let lastReport = null;

export async function refreshShift() {
  try {
    currentShift = await API.get('/api/shift/current');
    if (!currentShift) {
      $('shift-closed-card').style.display = '';
      $('shift-open-card').style.display = 'none';
      return;
    }
    $('shift-closed-card').style.display = 'none';
    $('shift-open-card').style.display = '';
    $('shift-status').textContent =
      `Opened ${new Date(currentShift.opened_at).toLocaleString()} · Float ${fmt(currentShift.float_cents / 100)}`;
    await refreshXReport();
  } catch (e) { toast('Shift load error: ' + e.message); console.error(e); }
}

async function refreshXReport() {
  if (!currentShift) return;
  try {
    const r = await API.get(`/api/shift/${currentShift.id}/report`);
    renderReportSummary($('shift-x-report'), r);
  } catch (e) { console.error(e); }
}

function renderReportSummary(el, r) {
  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td>Gross sales</td><td style="text-align:right">${fmt(r.gross_cents / 100)}</td></tr>
      <tr><td>Discounts</td><td style="text-align:right">${fmt(r.discounts_cents / 100)}</td></tr>
      <tr><td>Comps</td><td style="text-align:right">${fmt(r.comps_cents / 100)}</td></tr>
      <tr><td>Voids</td><td style="text-align:right">${r.voids_count} / ${fmt(r.voids_cents / 100)}</td></tr>
      <tr><td>Refunds</td><td style="text-align:right">${fmt(r.refunds_cents / 100)}</td></tr>
      <tr><td style="font-weight:700">Net sales</td><td style="text-align:right;font-weight:700">${fmt(r.net_sales_cents / 100)}</td></tr>
      <tr><td>Service charge</td><td style="text-align:right">${fmt(r.service_charge_cents / 100)}</td></tr>
      <tr><td>SST</td><td style="text-align:right">${fmt(r.tax_cents / 100)}</td></tr>
      <tr><td>Rounding</td><td style="text-align:right">${fmt(r.rounding_cents / 100)}</td></tr>
      <tr><td>Orders</td><td style="text-align:right">${r.order_count} (avg ${fmt(r.avg_check_cents / 100)})</td></tr>
      <tr><td>Open orders carried fwd</td><td style="text-align:right">${r.carried_forward.count} / ${fmt(r.carried_forward.cents / 100)}</td></tr>
    </table>
    <div style="margin-top:10px;font-weight:700">Payment mix</div>
    ${r.payment_mix.map(m => `<div>${esc(m.method)}: ${fmt(m.cents / 100)}</div>`).join('') || '<div class="empty">None yet</div>'}
    <div style="margin-top:10px;font-weight:700">Refund mix</div>
    ${r.refund_mix.map(m => `<div>${esc(m.method)}: ${fmt(m.cents / 100)}</div>`).join('') || '<div class="empty">None</div>'}
    <div style="margin-top:10px;font-weight:700">Cash reconciliation</div>
    <div>Float ${fmt(r.cash.float_cents / 100)} · Cash sales ${fmt(r.cash.cash_sales_cents / 100)} · Pay in ${fmt(r.cash.payins_cents / 100)} · Pay out ${fmt(r.cash.payouts_cents / 100)} · Expected ${fmt(r.cash.expected_cents / 100)}${r.cash.counted_cents != null ? ' · Counted ' + fmt(r.cash.counted_cents / 100) + ' · Variance ' + fmt(r.cash.variance_cents / 100) : ''}</div>
    <div style="margin-top:10px;font-weight:700">Voids &amp; discounts by staff</div>
    ${r.staff_voids.map(v => `<div>${esc(v.staff)}: ${v.count} void(s) / ${fmt(v.cents / 100)}</div>`).join('') || '<div class="empty">None</div>'}
    <div style="margin-top:10px;font-weight:700">Refunds by staff</div>
    ${r.staff_refunds.map(v => `<div>${esc(v.staff)}: ${v.count} refund(s) / ${fmt(v.cents / 100)}</div>`).join('') || '<div class="empty">None</div>'}
    <div style="margin-top:10px;font-weight:700">Sales by category</div>
    ${r.categories.map(c => `<div>${esc(c.category)}: ${fmt(c.cents / 100)}</div>`).join('') || '<div class="empty">None</div>'}
    <div style="margin-top:10px;font-weight:700">Top items</div>
    ${r.top_items.map(i => `<div>${esc(i.name)}: ${i.sold}</div>`).join('') || '<div class="empty">None</div>'}`;
}

async function openShift() {
  const float = Number($('shift-float-input').value) || 0;
  try { await API.post('/api/shift/open', { float }); toast('Shift opened'); refreshShift(); }
  catch (e) { toast(e.message); }
}

async function addMovement() {
  const kind = $('movement-kind').value;
  const amount = Number($('movement-amount').value);
  const reason = $('movement-reason').value.trim();
  if (!(amount > 0)) return toast('Enter an amount');
  if (!reason) return toast('Enter a reason');
  try {
    await API.post('/api/shift/movements', { kind, amount, reason });
    $('movement-amount').value = ''; $('movement-reason').value = '';
    toast(kind === 'payin' ? 'Pay-in recorded' : 'Pay-out recorded');
    refreshShift();
  } catch (e) { toast(e.message); }
}

function revealClose() {
  $('denom-grid').innerHTML = DENOMS.map(([cents, label]) => `
    <div class="admin-row">
      <div>${label}</div>
      <input type="number" min="0" step="1" value="0" style="color:var(--charcoal);width:80px" data-action="denom-count" data-cents="${cents}">
    </div>`).join('');
  updateDenomTotal();
  $('shift-close-form').style.display = '';
}

function updateDenomTotal() {
  let totalCents = 0;
  $('denom-grid').querySelectorAll('[data-action="denom-count"]').forEach(inp => {
    totalCents += (parseInt(inp.value, 10) || 0) * Number(inp.dataset.cents);
  });
  $('denom-total').textContent = fmt(totalCents / 100);
  return totalCents;
}

async function confirmClose() {
  const countedCents = updateDenomTotal();
  const note = $('shift-close-note').value.trim();
  try {
    const closed = await API.post('/api/shift/close', { counted: countedCents / 100, note });
    toast('Shift closed');
    $('shift-close-form').style.display = 'none';
    await renderZReport(closed.id);
    refreshShift();
  } catch (e) { toast(e.message); }
}

async function renderZReport(shiftId) {
  try {
    lastReport = await API.get(`/api/shift/${shiftId}/report?final=1`);
    $('shift-report-card').style.display = '';
    const variance = lastReport.cash.variance_cents || 0;
    $('shift-variance-badge').innerHTML =
      `<span style="color:${variance === 0 ? 'var(--sage-deep)' : 'var(--red)'}">Variance ${fmt(variance / 100)}</span>`;
    renderReportSummary($('shift-z-report'), lastReport);
  } catch (e) { toast(e.message); }
}

function exportCsv() {
  if (!lastReport) return toast('No report to export');
  const r = lastReport;
  const rows = [
    ['Shift', r.shift_id], ['Gross sales', (r.gross_cents / 100).toFixed(2)],
    ['Discounts', (r.discounts_cents / 100).toFixed(2)], ['Comps', (r.comps_cents / 100).toFixed(2)],
    ['Voids count', r.voids_count], ['Voids value', (r.voids_cents / 100).toFixed(2)],
    ['Refunds', (r.refunds_cents / 100).toFixed(2)],
    ['Net sales', (r.net_sales_cents / 100).toFixed(2)], ['Service charge', (r.service_charge_cents / 100).toFixed(2)],
    ['SST', (r.tax_cents / 100).toFixed(2)], ['Rounding', (r.rounding_cents / 100).toFixed(2)],
    ['Orders', r.order_count], ['Avg check', (r.avg_check_cents / 100).toFixed(2)],
    ['Open orders carried fwd count', r.carried_forward.count], ['Open orders carried fwd value', (r.carried_forward.cents / 100).toFixed(2)],
    ['Float', (r.cash.float_cents / 100).toFixed(2)], ['Cash sales', (r.cash.cash_sales_cents / 100).toFixed(2)],
    ['Pay in', (r.cash.payins_cents / 100).toFixed(2)], ['Pay out', (r.cash.payouts_cents / 100).toFixed(2)],
    ['Expected', (r.cash.expected_cents / 100).toFixed(2)], ['Counted', ((r.cash.counted_cents || 0) / 100).toFixed(2)],
    ['Variance', ((r.cash.variance_cents || 0) / 100).toFixed(2)],
    ...r.payment_mix.map(m => [`Payment: ${m.method}`, (m.cents / 100).toFixed(2)]),
    ...r.refund_mix.map(m => [`Refund: ${m.method}`, (m.cents / 100).toFixed(2)]),
    ...r.staff_voids.map(v => [`Voids: ${v.staff}`, `${v.count} / ${(v.cents / 100).toFixed(2)}`]),
    ...r.staff_refunds.map(v => [`Refunds: ${v.staff}`, `${v.count} / ${(v.cents / 100).toFixed(2)}`]),
  ];
  const csv = rows.map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `shift-${r.shift_id}-z-report.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function printZReport() {
  const shiftId = lastReport ? lastReport.shift_id : currentShift?.id;
  if (!shiftId) return;
  try { await API.post(`/api/shift/${shiftId}/print-report?final=${lastReport ? '1' : '0'}`, {}); toast('Z report sent to printer'); }
  catch (e) { toast(e.message); }
}

$('tab-shift').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'open-shift') openShift();
  else if (action === 'add-movement') addMovement();
  else if (action === 'reveal-close') revealClose();
  else if (action === 'cancel-close') $('shift-close-form').style.display = 'none';
  else if (action === 'confirm-close') confirmClose();
  else if (action === 'export-z-csv') exportCsv();
  else if (action === 'print-z-report') printZReport();
});

$('tab-shift').addEventListener('input', e => {
  if (e.target.closest('[data-action="denom-count"]')) updateDenomTotal();
});
