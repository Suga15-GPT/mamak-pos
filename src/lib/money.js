const cents2rm = c => Math.round(c) / 100;
const rm2cents = r => Math.round(Number(r) * 100);
const roundCashCents = c => Math.round(c / 5) * 5;

// 0.5 always rounds away from zero: 2.5 -> 3, -2.5 -> -3.
const roundHalfUp = n => (n >= 0 ? Math.floor(n + 0.5) : -Math.floor(-n + 0.5));

const lineTotal = ({ price_cents, qty, mods = [] }) =>
  (price_cents + mods.reduce((s, m) => s + m.price_cents, 0)) * qty;

// Order of operations per docs/REBUILD-PLAN.md §3: subtotal -> service charge
// -> tax (on subtotal + service charge) -> discount -> cash rounding.
function computeBill({ lines, taxRateBp = 0, svcRateBp = 0, discountCents = 0, method }) {
  const subtotal_cents = lines.reduce((s, l) => s + lineTotal(l), 0);
  const service_charge_cents = roundHalfUp(subtotal_cents * svcRateBp / 10000);
  const tax_cents = roundHalfUp((subtotal_cents + service_charge_cents) * taxRateBp / 10000);
  const discount_cents = discountCents;
  const gross = subtotal_cents + service_charge_cents + tax_cents - discount_cents;
  const rounding_cents = method === 'Cash' ? roundCashCents(gross) - gross : 0;
  const total_cents = gross + rounding_cents;
  return { subtotal_cents, service_charge_cents, tax_cents, discount_cents, rounding_cents, total_cents };
}

const formatRM = cents => `RM ${(cents / 100).toFixed(2)}`;

module.exports = { cents2rm, rm2cents, roundCashCents, roundHalfUp, lineTotal, computeBill, formatRM };
