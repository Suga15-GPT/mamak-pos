const cents2rm = c => Math.round(c) / 100;
const rm2cents = r => Math.round(Number(r) * 100);
const roundCashCents = c => Math.round(c / 5) * 5;

module.exports = { cents2rm, rm2cents, roundCashCents };
