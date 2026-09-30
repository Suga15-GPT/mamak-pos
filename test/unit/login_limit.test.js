const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb } = require('../helper');
const { startApp, race } = require('../apphelper');

/* The login limit counts an attempt before anything is awaited, so a burst of
   simultaneous wrong PINs from one address gets exactly ten checks and the
   rest 429 — it used to check them all. A right PIN still never spends the
   budget, even in the middle of such a burst. And the login screen no longer
   arrives filled in with Admin / 1234. */

const RIGHT = '1234';
const WRONG = '9182';

// With TRUST_PROXY=1 the app takes the client's address from X-Forwarded-For,
// so each run can come from an address of its own and start with the whole
// budget: the limit is per address.
async function startBehindProxy() {
  const prev = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  try { return await startApp(); } finally {
    if (prev === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
  }
}

const loginFrom = (base, ip, pin) => fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  body: JSON.stringify({ name: 'Admin', pin }),
}).then(r => r.status);

const burst = (n, send) => () => Promise.all(Array.from({ length: n }, send));
const tally = statuses => statuses.reduce((t, s) => ({ ...t, [s]: (t[s] || 0) + 1 }), {});

test('race: 25 wrong PINs at once from one address — exactly 10 are checked and the other 15 get 429, and right PINs racing them spend none of it: 40 runs', async () => {
  await withDb(async () => {
    const base = await startBehindProxy();
    let rightIn = 0;
    let rightLockedOut = 0;
    for (let i = 0; i < 40; i++) {
      const ip = `203.0.113.${i + 1}`;
      // The right PINs go first, so when both start at once they are still
      // being checked as the wrong ones arrive: a right PIN holding a place
      // must not cost a wrong one its check.
      const [right, wrong] = await race(i,
        burst(3, () => loginFrom(base, ip, RIGHT)),
        burst(25, () => loginFrom(base, ip, WRONG)));
      assert.deepEqual(tally(wrong), { 401: 10, 429: 15 }, `run ${i}: exactly ten wrong PINs checked`);
      assert.ok(right.every(s => s === 200 || s === 429), `run ${i}: right PINs got ${right}`);
      if (right.every(s => s === 200)) rightIn++;
      if (right.includes(429)) rightLockedOut++;

      // The limit now holds against the right PIN too, and only for that address.
      assert.equal(await loginFrom(base, ip, RIGHT), 429, `run ${i}: that address waits`);
      assert.equal(await loginFrom(base, `198.51.100.${i + 1}`, RIGHT), 200, `run ${i}: another address does not`);
    }
    // Both orderings happened: right PINs let in while the guesses were being
    // checked, and right PINs that came after the tenth wrong one.
    assert.ok(rightIn > 0 && rightLockedOut > 0, `right PINs in: ${rightIn} runs; locked out: ${rightLockedOut} runs`);
  });
});

test('25 right PINs at once from one address all get in, and spend none of the budget: ten wrong ones are still checked after them', async () => {
  await withDb(async () => {
    const base = await startBehindProxy();
    for (let i = 0; i < 5; i++) {
      const ip = `203.0.113.${101 + i}`;
      assert.deepEqual(tally(await burst(25, () => loginFrom(base, ip, RIGHT))()), { 200: 25 }, `run ${i}: everyone in`);
      assert.deepEqual(tally(await burst(25, () => loginFrom(base, ip, WRONG))()), { 401: 10, 429: 15 }, `run ${i}: the whole budget left`);
    }
  });
});

test('the login screen arrives empty: no name or PIN filled in', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  for (const id of ['lname', 'lpin']) {
    const input = html.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`));
    assert.ok(input, `#${id} is on the page`);
    assert.doesNotMatch(input[0], /\bvalue\s*=/, `#${id} carries no value`);
  }
});
