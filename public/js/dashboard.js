import { $, fmt, esc } from './state.js';

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

/* A bar chart of sales by hour. Bars are labelled with the hour; the busiest
   bar carries its value so the chart is readable without a tooltip (there is
   no hover on the tablet this is read on). */
function hourlyChart(hourly) {
  if (!hourly.length) return '<div class="empty"><span class="big" aria-hidden="true">📈</span>No sales yet today</div>';
  const max = Math.max(...hourly.map(h => h.sales));
  const busiest = hourly.reduce((a, b) => (b.sales > a.sales ? b : a));
  // A wide, flat viewBox: the SVG scales to the card's width and keeps its
  // aspect ratio, so a tall box would render as a tall chart on a wide screen.
  const W = 600, H = 190, padL = 8, padB = 26, padT = 18;
  // Bars are capped and left-aligned: one busy hour early in the day should not
  // draw a single rectangle across the whole card.
  const slot = (W - padL * 2) / Math.max(hourly.length, 8);
  const bw = Math.min(34, Math.max(6, slot - 8));
  const plotH = H - padB - padT;
  const bars = hourly.map(h => {
    const i = hourly.indexOf(h);
    const barH = max ? Math.max(3, (plotH * h.sales) / max) : 3;
    const x = padL + i * slot + (slot - bw) / 2;
    const y = H - padB - barH;
    const peak = h.hour === busiest.hour;
    return `<rect class="bar${peak ? '' : ' dim'}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}"
              height="${barH.toFixed(1)}" rx="4"><title>${h.hour}:00 — ${fmt(h.sales)} (${h.orders} orders)</title></rect>
            ${peak ? `<text class="peak" x="${(x + bw / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle">${fmt(h.sales)}</text>` : ''}
            <text class="axis" x="${(x + bw / 2).toFixed(1)}" y="${H - padB + 15}" text-anchor="middle">${h.hour}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Sales by hour. Busiest hour ${busiest.hour}:00 with ${fmt(busiest.sales)}.">
      <line class="grid-line" x1="${padL}" y1="${H - padB}" x2="${W - padL}" y2="${H - padB}"/>
      ${bars}
    </svg>
    <div class="meta" style="margin-top:8px">Busiest hour <b>${busiest.hour}:00</b> — ${fmt(busiest.sales)} across ${busiest.orders} order${busiest.orders === 1 ? '' : 's'}.</div>`;
}

/* Ranked rows with a proportional bar. Reads as a list first and a chart
   second, which is the right way round for "what sold today". */
function barList(rows, { valueOf, labelOf, fill = '' }) {
  if (!rows.length) return '<div class="empty"><span class="big" aria-hidden="true">🍽</span>Nothing yet today</div>';
  const max = Math.max(...rows.map(valueOf)) || 1;
  return `<div class="bar-list">${rows.map(r => `
    <div class="bar-row">
      <span class="bar-name">${esc(labelOf(r).name)}</span>
      <span class="bar-val">${esc(labelOf(r).value)}</span>
      <span class="bar-track"><span class="bar-fill ${fill}" style="width:${((valueOf(r) / max) * 100).toFixed(1)}%"></span></span>
    </div>`).join('')}</div>`;
}

export async function refreshDashboard() {
  try {
    const d = await API.get('/api/dashboard');

    const stamp = $('dash-updated');
    if (stamp) stamp.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    $('dash-kpis').innerHTML = [
      kpi({ label: 'Today sales', value: fmt(d.today.sales), cls: 'hero', sub: comparison(d.today.sales, d.yesterday.sales) }),
      kpi({ label: 'Orders', value: String(d.today.orders), sub: { text: `${d.today.dine_in.orders} dine in · ${d.today.takeaway.orders} takeaway` } }),
      kpi({ label: 'Average order', value: fmt(d.today.average_order) }),
      kpi({ label: 'Open tables', value: String(d.floor.open_tables), sub: { text: `${fmt(d.floor.open_value)} on the floor` } }),
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

    $('dash-hourly').innerHTML = hourlyChart(d.hourly);

    $('dash-top').innerHTML = barList(d.top_items, {
      valueOf: r => r.sold,
      labelOf: r => ({ name: r.name, value: `${r.sold} · ${fmt(r.sales)}` }),
    });

    $('dash-mix').innerHTML = barList(d.payment_mix, {
      valueOf: r => r.sales,
      labelOf: r => ({ name: r.method, value: fmt(r.sales) }),
      fill: 'sage',
    }) + `<div class="meta" style="margin-top:10px">
        Dine in ${fmt(d.today.dine_in.sales)} · Takeaway ${fmt(d.today.takeaway.sales)}
      </div>`;

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
