// split-math.js — the arithmetic behind "Split the bill" (split.js), kept
// free of the page so the unit tests can run it. Whole sen throughout; every
// split adds up to exactly what it splits.

// n shares of `cents`, as even as sen allow: the first ones take the extra sen.
export function splitEvenCents(cents, n) {
  const k = Math.max(1, Math.floor(n));
  const base = Math.floor(cents / k);
  return Array.from({ length: k }, (_, i) => base + (i < cents - base * k ? 1 : 0));
}

// Splits `total` sen in proportion to `weights`, summing exactly to `total`.
export function proportional(total, weights) {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (!sumW) return weights.map(() => 0);
  const exact = weights.map(w => (total * w) / sumW);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  exact.map((x, i) => [x - Math.floor(x), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .forEach(([, i]) => { if (left > 0) { out[i]++; left--; } });
  return out;
}

/* bill: { due, lines: [{ id, name, qty, amount, paid }] } (RM, as the API sends)
   people: ['Ali', 'Siti']; assigned: { [lineId]: ['Ali', ...] }.
   Returns each person's share of what is left to pay, their dishes, and what
   nobody has claimed yet. SST, service charge and any discount are shared in
   the same proportion as the food, as "Split by items" does at the till. */
export function splitByItems(bill, people, assigned) {
  const due = Math.round((bill.due || 0) * 100);
  const open = bill.lines.filter(l => !l.paid && l.amount > 0);
  const weight = Object.fromEntries(people.map(p => [p, 0]));
  const dishes = Object.fromEntries(people.map(p => [p, []]));
  let unclaimed = 0;
  const unclaimedLines = [];
  for (const l of open) {
    const cents = Math.round(l.amount * 100);
    const who = (assigned[l.id] || []).filter(p => p in weight);
    if (!who.length) { unclaimed += cents; unclaimedLines.push(l); continue; }
    splitEvenCents(cents, who.length).forEach((c, i) => { weight[who[i]] += c; });
    who.forEach(p => dishes[p].push(who.length > 1 ? `${l.qty}× ${l.name} (shared ÷${who.length})` : `${l.qty}× ${l.name}`));
  }
  const weights = [...people.map(p => weight[p]), unclaimed];
  // Every dish paid for, yet something still due (a part payment's
  // remainder): nobody's food explains it, so it shows as not claimed.
  const parts = weights.some(w => w > 0) ? proportional(due, weights) : [...people.map(() => 0), due];
  return {
    due,
    people: people.map((p, i) => ({ name: p, cents: parts[i], dishes: dishes[p] })),
    unclaimed_cents: parts[people.length],
    unclaimed_lines: unclaimedLines,
  };
}

