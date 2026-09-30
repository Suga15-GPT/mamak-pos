const path = require('path');
const assert = require('node:assert/strict');
const { getFreePort } = require('./helper');

/* The app, started in-process against the temp schema withDb() made, and the
   few calls every day-one test uses. Each test file used to carry its own
   copy of these; the day-one files share this one. */

const SRC_DIR = path.join(__dirname, '..', 'src') + path.sep;
const DB_MODULE = require.resolve('../src/db');
const SERVER_MODULE = require.resolve('../src/server');

function clearSrcCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_DIR) && key !== DB_MODULE) delete require.cache[key];
  }
}

async function waitReady(base, retries = 50) {
  for (let i = 0; i < retries; i++) {
    try { await fetch(`${base}/api/menu`); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error(`server at ${base} never became ready`);
}

async function startApp() {
  const port = await getFreePort();
  process.env.PORT = String(port);
  process.env.ADMIN_PIN = '1234';
  clearSrcCache();
  require(SERVER_MODULE);
  const base = `http://localhost:${port}`;
  await waitReady(base);
  return base;
}

const json = res => res.json();

async function login(base, name, pin) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, pin }),
  });
  const body = await json(r);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrfToken: body.csrf_token };
}
const headers = s => ({ cookie: s.cookie, 'x-csrf-token': s.csrfToken, 'content-type': 'application/json' });

/* Logged in as the seeded admin, with the menu and the cards to hand. Opens a
   shift unless told not to. */
async function setup(base, { shift = true } = {}) {
  const h = headers(await login(base, 'Admin', '1234'));
  if (shift) await fetch(`${base}/api/shift/open`, { method: 'POST', headers: h, body: JSON.stringify({ float: 0 }) });
  const menu = await json(await fetch(`${base}/api/menu`, { headers: h }));
  const cards = await json(await fetch(`${base}/api/admin/cards`, { headers: h }));
  const byName = n => menu.items.find(i => i.name === n);
  const s = { h, cards, roti: byName('Roti Canai'), teh: byName('Teh Tarik'), mee: byName('Mee Goreng Mamak'), telur: byName('Roti Telur') };
  s.card = n => s.cards.find(c => c.number === n);
  return s;
}

const call = (base, s, method, url, body) => fetch(`${base}${url}`, {
  method, headers: s.h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const post = (base, s, url, body) => call(base, s, 'POST', url, body || {});
const patch = (base, s, url, body) => call(base, s, 'PATCH', url, body || {});
const del = (base, s, url) => call(base, s, 'DELETE', url);
const get = async (base, s, url) => json(await fetch(`${base}${url}`, { headers: s.h }));
const publicOrder = (base, body) => fetch(`${base}/api/public/orders`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function openCard(base, s, number, items) {
  const r = await post(base, s, '/api/orders', { card_id: s.card(number).id, items: items || [{ item_id: s.roti.id, qty: 1 }] });
  assert.equal(r.status, 201, `opening Card ${number}`);
  return (await json(r)).id;
}
const one = item => [{ item_id: item.id, qty: 1 }];

// Enough cards for many runs of a race.
async function manyCards(base, s, count = 200) {
  assert.equal((await patch(base, s, '/api/admin/cards/count', { count })).status, 200);
  s.cards = await json(await fetch(`${base}/api/admin/cards`, { headers: s.h }));
}

/* Run i of a race: a third of the runs start both requests at once, a third
   let the first lead by 15 ms and a third the second, so every ordering is
   actually tried rather than left to chance. */
function race(i, first, second) {
  const lag = ms => new Promise(r => setTimeout(r, ms));
  if (i % 3 === 1) return Promise.all([first(), lag(15).then(second)]);
  if (i % 3 === 2) return Promise.all([lag(15).then(first), second()]);
  return Promise.all([first(), second()]);
}

const orderRow = (db, id) => db.query('SELECT * FROM orders WHERE id = $1', [id]).then(r => r.rows[0]);

/* The books balance on one order: its stored subtotal is exactly its live,
   accepted lines, and a paid order's payments are exactly its total. */
async function assertBalanced(db, id, label) {
  const o = await orderRow(db, id);
  const lines = (await db.query(
    `SELECT COALESCE(SUM((oi.price_cents + COALESCE((SELECT SUM(m.price_cents) FROM order_item_mods m WHERE m.order_item_id = oi.id), 0)) * oi.qty), 0)::int s
       FROM order_items oi LEFT JOIN order_sends se ON se.id = oi.send_id
      WHERE oi.order_id = $1 AND oi.voided_at IS NULL AND (se.id IS NULL OR se.approval_state = 'approved')`, [id])).rows[0].s;
  assert.equal(o.subtotal_cents, lines, `${label}: the bill is exactly its lines`);
  if (o.status === 'paid') {
    const paid = (await db.query('SELECT COALESCE(SUM(amount_cents), 0)::int s FROM payments WHERE order_id = $1', [id])).rows[0].s;
    assert.equal(paid, o.total_cents, `${label}: a paid order's payments equal its total`);
  }
}

module.exports = {
  startApp, login, headers, setup, call, post, patch, del, get, json, publicOrder,
  openCard, one, manyCards, race, orderRow, assertBalanced,
};
