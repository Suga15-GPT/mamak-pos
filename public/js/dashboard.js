import { $, fmt, esc } from './state.js';
import { on } from './features.js';

/* ===== DASHBOARD =====
   The owner should understand the business in about five seconds: money first,
   then what the floor and the kitchen are doing right now.

   Charts are hand-drawn SVG. A charting library would be 60-200 KB over a
   restaurant's connection to draw a bar chart of twelve numbers, and every
   colour would then live outside the CSS variables the rest of the app uses. */

function kpi({ label, value, sub, cls = '' }) {
  return `<div class="kpi ${cls}">
    <div class="l">${esc(label)}</div>
    <div class="v">${esc(value)}</div>
    ${sub ? `<div class="s ${esc(sub.cls || '')}">${esc(sub.text)}</div>` : ''}
  </div>`;
}

// Yesterday at the same point isn't available (only its whole-day total is), so
// this compares whole day to whole day and says so, rather than implying a
// like-for-like it can't measure.
function comparison(today, yesterday) {
  if (!yesterday) return { text: 'No sales yesterday', cls: '' };
  const pct = Math.round(((today - yesterday) / yesterday) * 100);
  if (pct === 0) return { text: 'Same as all day yesterday', cls: '' };
  return {
    text: `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs all day yesterday`,
    cls: pct > 0 ? 'up' : 'down',
  };
}

/* Ranked rows with a proportional bar. Reads as a list first and a chart
   second, which is the right way round for "what sold today". */
function barList(rows, { valueOf, labelOf, fill = '' }) {
  if (!rows.length) return '<div class="empty"><span class="big" aria-hidden="true">🍽</span>Nothing in this period</div>';
  const max = Math.max(...rows.map(valueOf)) || 1;
  return `<div class="bar-list">${rows.map(r => `
    <div class="bar-row">
      <span class="bar-name">${esc(labelOf(r).name)}</span>
      <span class="bar-val">${esc(labelOf(r).value)}</span>
      <span class="bar-track"><span class="bar-fill ${fill}" style="width:${((valueOf(r) / max) * 100).toFixed(1)}%"></span></span>
    </div>`).join('')}</div>`;
}

/* ===== SALES EXPLORER =====
   Any timeframe, by hour, day or month, with filters, the previous period of
   the same length for comparison, and the same figures as a table (and a CSV).
   Tap a month to see its days, a day to see its hours; Back returns. What the
   figures mean is set on the server (services/analytics.js) — the Z report's
   meaning, so the two always agree. */

const KL_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
const todayKL = () => KL_DATE.format(new Date());
const shift = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monthStart = d => `${d.slice(0, 7)}-01`;
const monthEnd = d => { const x = new Date(`${monthStart(d)}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };

function rangeFor(name) {
  const t = todayKL();
  switch (name) {
    case 'yesterday': return { from: shift(t, -1), to: shift(t, -1) };
    case '7d': return { from: shift(t, -6), to: t };
    case '30d': return { from: shift(t, -29), to: t };
    case 'month': return { from: monthStart(t), to: t };
    case 'lastmonth': { const last = shift(monthStart(t), -1); return { from: monthStart(last), to: last }; }
    case 'year': return { from: `${t.slice(0, 4)}-01-01`, to: t };
    default: return { from: t, to: t };
  }
}

const ex = { range: 'today', ...rangeFor('today'), bucket: 'auto', type: 'all', method: 'all', category: 'all', stack: [], data: null, seq: 0 };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function labelOf(key, bucket, multiDay) {
  const [d, h] = key.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  if (bucket === 'month') return `${MONTHS[m - 1]} ${y}`;
  const dow = DAYS[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
  if (bucket === 'day') return `${dow} ${dd} ${MONTHS[m - 1]}`;
  return multiDay ? `${dd} ${MONTHS[m - 1]} ${h}` : h;
}
function shortLabel(key, bucket) {
  const [d, h] = key.split('T');
  const [, m, dd] = d.split('-').map(Number);
  if (bucket === 'month') return MONTHS[m - 1];
  if (bucket === 'day') return String(dd);
  return h.slice(0, 2);
}
const rangeText = (from, to) => {
  const f = d => { const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MONTHS[m - 1]} ${y}`; };
  return from === to ? f(from) : `${f(from)} – ${f(to)}`;
};
const rm = c => fmt(c / 100);

// The figure the chart draws: net sales, a category's item sales, or the
// money taken by one payment method less its refunds.
const valueOf = r => r.net_cents;
function measureName(d) {
  if (d.measure === 'category') return `Item sales — ${categoryName(d.filters.category)}`;
  if (d.measure === 'method') return `Taken by ${d.filters.method} (less refunds)`;
  return 'Net sales';
}
function categoryName(id) {
  const o = [...$('ex-category').options].find(x => x.value === String(id));
  return o ? o.textContent : 'category';
}

// By month the comparison is the same months last year; otherwise the same
// number of days just before.
const prevName = d => (d.previous_range.kind === 'last_year' ? 'the same months last year' : 'the previous period');
function pctChange(now, before, name) {
  if (!before) return now ? { text: `no sales in ${name}`, cls: '' } : { text: `same as ${name}`, cls: '' };
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  if (pct === 0) return { text: `same as ${name}`, cls: '' };
  return { text: `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs ${name}`, cls: pct > 0 ? 'up' : 'down' };
}

function renderSummary(d) {
  const t = d.totals, p = d.previous_totals;
  const cmp = pctChange(valueOf(t), valueOf(p), prevName(d));
  const stats = [
    `<span class="ex-stat">Bills <b>${t.bills}</b></span>`,
    `<span class="ex-stat">Average bill <b>${rm(t.average_cents)}</b></span>`,
  ];
  if (d.measure !== 'category') stats.push(`<span class="ex-stat">Refunds <b>${rm(t.refunds_cents)}</b></span>`);
  if (d.expenses) {
    stats.push(`<span class="ex-stat">Expenses <b>${rm(d.expenses.total_cents)}</b></span>`);
    stats.push(`<span class="ex-stat">Sales − expenses <b>${rm(t.net_cents - d.expenses.total_cents)}</b></span>`);
  }
  $('ex-summary').innerHTML = `
    <div><div class="ex-stat">${esc(measureName(d))} · ${esc(rangeText(d.from, d.to))}</div>
      <div class="ex-hero">${rm(valueOf(t))}</div>
      <div class="ex-stat ${cmp.cls}">${esc(cmp.text)} (${esc(rangeText(d.previous_range.from, d.previous_range.to))}: ${rm(valueOf(p))})</div></div>
    ${stats.join('')}`;
}

/* Bars for this period, a short line at the previous period's value in the
   same slot. One axis; the top gridline is labelled with its value. Each slot
   has a tap target the full height of the plot. */
function renderChart(d) {
  const rows = d.rows;
  if (!rows.some(r => r.bills || r.refunds_cents) && !d.previous.some(r => r.bills)) {
    $('ex-chart').innerHTML = '<div class="empty"><span class="big" aria-hidden="true">📈</span>No sales in this period</div>';
    return;
  }
  const multiDay = d.from !== d.to;
  const prevBy = d.previous;
  const vals = rows.map(valueOf).concat(prevBy.map(r => r.net_cents));
  const max = Math.max(1, ...vals);
  // Drawn at the width it is shown at, so its labels stay readable on a phone
  // instead of shrinking with a scaled-down picture.
  const W = Math.max(300, Math.round($('ex-chart').clientWidth || 640));
  const H = W < 560 ? 200 : 240, padL = 44, padR = 8, padT = 14, padB = 26;
  const plotH = H - padT - padB, plotW = W - padL - padR;
  const slot = plotW / rows.length;
  const bw = Math.max(2, Math.min(36, slot - Math.max(2, slot * 0.25)));
  const y = v => padT + plotH - (Math.max(0, v) / max) * plotH;
  const drill = d.bucket !== 'hour';
  const every = Math.ceil(rows.length / Math.max(4, Math.floor(plotW / 48)));
  const busiest = rows.reduce((a, b) => (valueOf(b) > valueOf(a) ? b : a), rows[0]);
  const marks = rows.map((r, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const v = valueOf(r);
    const top = y(v);
    const h = Math.max(v > 0 ? 3 : 0, padT + plotH - top);
    const prev = prevBy[i];
    const label = labelOf(r.key, d.bucket, multiDay);
    const tip = `${label}: ${rm(v)} · ${r.bills} bill${r.bills === 1 ? '' : 's'}${prev ? ` · previous ${rm(prev.net_cents)}` : ''}`;
    return `<g>
      <rect class="hit" x="${(padL + i * slot).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH}"
        ${drill ? `data-drill="${esc(r.key)}" tabindex="0" role="button" aria-label="${esc(tip)}. Show its ${d.bucket === 'month' ? 'days' : 'hours'}."` : ''}><title>${esc(tip)}</title></rect>
      <rect class="bar${r === busiest && v > 0 ? '' : ' dim'}" x="${x.toFixed(1)}" y="${(padT + plotH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(4, bw / 2).toFixed(1)}" pointer-events="none"></rect>
      ${prev && prev.net_cents > 0 ? `<line class="prev" x1="${(x - 2).toFixed(1)}" x2="${(x + bw + 2).toFixed(1)}" y1="${y(prev.net_cents).toFixed(1)}" y2="${y(prev.net_cents).toFixed(1)}" pointer-events="none"/>` : ''}
      ${i % every === 0 ? `<text class="axis" x="${(x + bw / 2).toFixed(1)}" y="${H - padB + 15}" text-anchor="middle">${esc(shortLabel(r.key, d.bucket))}</text>` : ''}
    </g>`;
  }).join('');
  $('ex-chart').innerHTML = `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(measureName(d))} by ${d.bucket}, ${esc(rangeText(d.from, d.to))}. The table below has every figure.">
      <line class="grid-line" x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}"/>
      <text class="ylab" x="${padL - 6}" y="${padT + 4}" text-anchor="end">${esc(rm(max).replace('RM ', ''))}</text>
      <line class="grid-line" x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}"/>
      <text class="ylab" x="${padL - 6}" y="${padT + plotH + 4}" text-anchor="end">0</text>
      ${marks}
    </svg>
    <div class="ex-legend"><span><span class="sw"></span>${esc(rangeText(d.from, d.to))}</span>
      <span><span class="sw prev"></span>${d.previous_range.kind === 'last_year' ? 'Same months last year' : 'Previous period'} (${esc(rangeText(d.previous_range.from, d.previous_range.to))})</span></div>`;
  $('ex-note').textContent = drill
    ? `Tap a ${d.bucket} to see its ${d.bucket === 'month' ? 'days' : 'hours'}.`
    : '';
}

function tableModel(d) {
  const multiDay = d.from !== d.to;
  const cat = d.measure === 'category';
  const cols = cat
    ? [['Period', r => r.label], ['Bills', r => r.bills, true], ['Item sales', r => rm(r.sales_cents), true]]
    : [['Period', r => r.label], ['Bills', r => r.bills, true], [d.measure === 'method' ? 'Taken' : 'Sales', r => rm(r.sales_cents), true],
      ['Refunds', r => rm(r.refunds_cents), true], ['Net', r => rm(r.net_cents), true],
      ['Average bill', r => rm(r.bills ? Math.round(r.sales_cents / r.bills) : 0), true]];
  // Expenses are dated, not timed: by day or month only.
  if (d.expenses?.by_bucket) {
    cols.push(['Expenses', r => rm(r.expenses_cents || 0), true]);
    cols.push(['Sales − expenses', r => rm(r.net_cents - (r.expenses_cents || 0)), true]);
  }
  const rows = d.rows.map(r => ({ ...r, label: labelOf(r.key, d.bucket, multiDay) }));
  const t = { ...d.totals, label: 'Total', expenses_cents: d.expenses ? d.expenses.total_cents : 0 };
  t.average_cents = d.totals.average_cents;
  return { cols, rows, total: t };
}

function renderTable(d) {
  const { cols, rows, total } = tableModel(d);
  const drill = d.bucket !== 'hour';
  $('ex-table').innerHTML = `
    <thead><tr>${cols.map(([h, , n]) => `<th class="${n ? 'num' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr class="${drill ? 'drill' : ''}${r.bills || r.refunds_cents ? '' : ' zero'}" ${drill ? `data-drill="${esc(r.key)}"` : ''}>
      ${cols.map(([, f, n]) => `<td class="${n ? 'num' : ''}">${esc(String(f(r)))}</td>`).join('')}</tr>`).join('')}</tbody>
    <tfoot><tr>${cols.map(([, f, n], i) => `<td class="${n ? 'num' : ''}">${esc(String(i === 0 ? 'Total' : f(total)))}</td>`).join('')}</tr></tfoot>`;
}

function exportCsv() {
  const d = ex.data;
  if (!d) return;
  const { cols, rows, total } = tableModel(d);
  const cell = v => { const s = String(v).replace(/^RM\s*/, ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.map(([h]) => cell(h + (h === 'Period' || h === 'Bills' ? '' : ' (RM)'))).join(',')]
    .concat(rows.map(r => cols.map(([, f]) => cell(f(r))).join(',')))
    .concat([cols.map(([, f], i) => cell(i === 0 ? 'Total' : f(total))).join(',')]);
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sales_${d.from}_to_${d.to}_by_${d.bucket}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function renderSideCards(d) {
  $('dash-top').innerHTML = barList(d.top_items, {
    valueOf: r => r.sold,
    labelOf: r => ({ name: r.name, value: `${r.sold} · ${rm(r.cents)}` }),
  });
  $('dash-mix').innerHTML = barList(d.payment_mix, {
    valueOf: r => r.cents,
    labelOf: r => ({ name: r.method, value: `${rm(r.cents)} · ${r.count}` }),
    fill: 'sage',
  });
  $('dash-categories').innerHTML = barList(d.categories, {
    valueOf: r => r.cents,
    labelOf: r => ({ name: r.name, value: rm(r.cents) }),
    fill: 'info',
  }) + (d.categories.length ? '<div class="meta" style="margin-top:10px">Item prices before SST and bill discounts.</div>' : '');
}

function syncControls() {
  document.querySelectorAll('#sales-explorer [data-range]').forEach(b => {
    const onNow = b.dataset.range === ex.range;
    b.classList.toggle('on', onNow);
    b.setAttribute('aria-pressed', String(onNow));
  });
  $('ex-custom').hidden = ex.range !== 'custom';
  $('ex-from').value = ex.from;
  $('ex-to').value = ex.to;
  $('ex-bucket').value = ex.bucket;
  $('ex-type').value = ex.type;
  $('ex-method').value = ex.method;
  $('ex-category').value = ex.category;
  $('ex-back').hidden = !ex.stack.length;
}

async function loadCategories() {
  const sel = $('ex-category');
  if (sel.options.length > 1) return;
  const menu = await API.get('/api/menu').catch(() => null);
  (menu?.categories || []).forEach(c => sel.insertAdjacentHTML('beforeend', `<option value="${c.id}">${esc(c.name)}</option>`));
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (ex.data && $('ex-chart').clientWidth) renderChart(ex.data); }, 150);
});

export async function refreshExplorer() {
  if (!on('dashboard')) return;
  syncControls();
  const seq = ++ex.seq;
  const q = new URLSearchParams({ from: ex.from, to: ex.to });
  if (ex.bucket !== 'auto') q.set('bucket', ex.bucket);
  if (ex.type !== 'all') q.set('order_type', ex.type);
  if (ex.method !== 'all') q.set('method', ex.method);
  if (ex.category !== 'all') q.set('category', ex.category);
  try {
    const d = await API.get(`/api/analytics?${q}`);
    if (seq !== ex.seq) return; // a newer choice is already on its way
    ex.data = d;
    renderSummary(d);
    renderChart(d);
    renderTable(d);
    renderSideCards(d);
  } catch (e) {
    if (seq !== ex.seq) return;
    ex.data = null;
    $('ex-summary').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    $('ex-chart').innerHTML = '';
    $('ex-table').innerHTML = '';
    $('ex-note').textContent = '';
  }
}

function drillInto(key) {
  const d = ex.data;
  if (!d || d.bucket === 'hour') return;
  ex.stack.push({ range: ex.range, from: ex.from, to: ex.to, bucket: ex.bucket });
  const day = key.slice(0, 10);
  if (d.bucket === 'month') { ex.from = day < d.from ? d.from : day; const end = monthEnd(day); ex.to = end > d.to ? d.to : end; ex.bucket = 'day'; }
  else { ex.from = day; ex.to = day; ex.bucket = 'hour'; }
  ex.range = 'custom';
  refreshExplorer();
}

$('sales-explorer').addEventListener('click', e => {
  const r = e.target.closest('[data-range]');
  if (r) {
    ex.stack = [];
    ex.range = r.dataset.range;
    if (ex.range === 'custom') { syncControls(); $('ex-from').focus(); return; }
    Object.assign(ex, rangeFor(ex.range));
    ex.bucket = 'auto';
    refreshExplorer();
    return;
  }
  const dr = e.target.closest('[data-drill]');
  if (dr) return drillInto(dr.dataset.drill);
  const a = e.target.closest('[data-action]')?.dataset.action;
  if (a === 'ex-back' && ex.stack.length) { Object.assign(ex, ex.stack.pop()); refreshExplorer(); }
  else if (a === 'ex-export') exportCsv();
  else if (a === 'ex-apply') {
    const from = $('ex-from').value, to = $('ex-to').value;
    if (!from || !to) return;
    ex.from = from <= to ? from : to;
    ex.to = from <= to ? to : from;
    ex.bucket = 'auto';
    ex.stack = [];
    refreshExplorer();
  }
});
$('sales-explorer').addEventListener('keydown', e => {
  const dr = e.target.closest?.('[data-drill]');
  if (dr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); drillInto(dr.dataset.drill); }
});
$('sales-explorer').addEventListener('change', e => {
  const id = e.target.id;
  if (id === 'ex-bucket') ex.bucket = e.target.value;
  else if (id === 'ex-type') ex.type = e.target.value;
  // A category and a payment method measure different things; picking one
  // puts the other back to All.
  else if (id === 'ex-method') { ex.method = e.target.value; if (ex.method !== 'all') ex.category = 'all'; }
  else if (id === 'ex-category') { ex.category = e.target.value; if (ex.category !== 'all') ex.method = 'all'; }
  else return;
  refreshExplorer();
});

export async function refreshDashboard() {
  // Switched off, the 💰 Sales tab isn't shown and its figures 404 (nav.js).
  if (!on('dashboard')) return;
  try {
    const d = await API.get('/api/dashboard');

    const stamp = $('dash-updated');
    if (stamp) stamp.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    $('dash-kpis').innerHTML = [
      kpi({ label: 'Today sales', value: fmt(d.today.sales), cls: 'hero', sub: comparison(d.today.sales, d.yesterday.sales) }),
      kpi({ label: 'Orders', value: String(d.today.orders), sub: { text: `${d.today.dine_in.orders} dine in · ${d.today.takeaway.orders} takeaway` } }),
      kpi({ label: 'Average order', value: fmt(d.today.average_order) }),
      kpi({ label: 'Cards in use', value: String(d.floor.open_cards), sub: { text: `${fmt(d.floor.open_value)} on the floor` } }),
      kpi({
        label: 'Ready to pay', value: String(d.floor.ready_to_pay),
        cls: d.floor.ready_to_pay ? 'good' : '',
        sub: d.floor.ready_to_pay ? { text: 'Go and collect', cls: 'up' } : null,
      }),
      kpi({
        label: 'Late in kitchen', value: String(d.kitchen.late_tickets),
        cls: d.kitchen.late_tickets ? 'alert' : '',
        sub: { text: d.kitchen.longest_active_minutes ? `Oldest ${d.kitchen.longest_active_minutes} min` : 'Nothing waiting', cls: d.kitchen.late_tickets ? 'down' : '' },
      }),
      kpi({ label: 'This month', value: fmt(d.month.sales) }),
      kpi({ label: 'This year', value: fmt(d.year.sales) }),
    ].join('');

    await loadCategories();
    refreshExplorer();

    const k = d.kitchen, a = d.adjustments;
    $('dash-kitchen').innerHTML = `
      <div class="totals">
        <div class="row"><span>🍳 Cooking or waiting</span><span>${k.active_tickets} ticket${k.active_tickets === 1 ? '' : 's'}</span></div>
        <div class="row"><span>⏱ Average preparation</span><span>${k.avg_prep_minutes ? `${k.avg_prep_minutes} min` : 'no data yet'}</span></div>
        <div class="row"><span>⏱ Longest waiting now</span><span>${k.longest_active_minutes} min</span></div>
        <div class="row"><span>🔴 Late (over 10 min)</span><span>${k.late_tickets}</span></div>
        ${k.pending_approval ? `<div class="row"><span>⏳ Customer orders to accept</span><span>${k.pending_approval}</span></div>` : ''}
      </div>
      <div class="bill-group-head" style="margin-top:14px">Today's adjustments</div>
      <div class="totals">
        <div class="row"><span>❌ Voids</span><span>${a.voids_count} · ${fmt(a.voids)}</span></div>
        <div class="row"><span>🏷 Discounts</span><span>${fmt(a.discounts)}</span></div>
        <div class="row"><span>↩ Refunds</span><span>${fmt(a.refunds)}</span></div>
      </div>`;
  } catch (e) {
    $('dash-kpis').innerHTML = `<div class="empty">Could not load the dashboard: ${esc(e.message)}</div>`;
  }
}

$('tab-dashboard').addEventListener('click', e => {
  if (e.target.closest('[data-action="refresh-dashboard"]')) refreshDashboard();
});
