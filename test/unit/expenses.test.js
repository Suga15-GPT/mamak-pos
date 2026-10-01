const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb } = require('../helper');
const { startApp, login, headers, setup, post, patch, get, json, openCard, one } = require('../apphelper');

/* 🧾 Expenses: recorded by hand, from a receipt photo or a voice note (a
   draft the owner checks — the model never saves anything), regular costs
   confirmed when due, and Sales − expenses on the dashboard. */

const todayOf = async db => (await db.query("SELECT to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') d")).rows[0].d;
const shiftDay = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');

async function staffSession(base, s) {
  assert.equal((await post(base, s, '/api/admin/users', { name: 'Siti', role: 'staff', pin: '9157' })).status, 200);
  const first = { h: headers(await login(base, 'Siti', '9157')) };
  assert.equal((await post(base, first, '/api/me/pin', { current_pin: '9157', new_pin: '4826' })).status, 200);
  return first;
}

test('an expense is recorded, checked, listed by month with its category total, edited and voided — never deleted', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const today = await todayOf(db);
    const meta = await get(base, s, '/api/expenses/meta');
    const gas = meta.categories.find(c => c.name === 'Gas');
    assert.ok(gas);

    const bad = async (body, re) => {
      const r = await post(base, s, '/api/expenses', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match((await json(r)).error, re);
    };
    await bad({ spent_on: today, amount: 0, method: 'Cash' }, /how much/);
    await bad({ spent_on: shiftDay(today, 2), amount: 5, method: 'Cash' }, /future/);
    await bad({ spent_on: 'yesterday', amount: 5, method: 'Cash' }, /date/);
    await bad({ spent_on: today, amount: 5, method: 'Bitcoin' }, /how it was paid/);
    await bad({ spent_on: today, amount: 5, method: 'Cash', category_id: 99999 }, /category/);

    const r = await post(base, s, '/api/expenses', { spent_on: today, amount: 45.5, method: 'Cash', category_id: gas.id, supplier: '  Petronas  gas ', description: '2 tong' });
    assert.equal(r.status, 201);
    const { id } = await json(r);
    await post(base, s, '/api/expenses', { spent_on: today, amount: 10, method: 'Card', category_id: gas.id });

    let month = await get(base, s, `/api/expenses?month=${today.slice(0, 7)}`);
    assert.equal(month.total_cents, 5550);
    assert.deepEqual(month.by_category, [{ name: 'Gas', cents: 5550 }]);
    assert.equal(month.expenses.find(e => e.id === id).supplier, 'Petronas gas');

    assert.equal((await patch(base, s, `/api/expenses/${id}`, { amount: 46 })).status, 200);
    assert.equal((await post(base, s, `/api/expenses/${id}/void`, { reason: 'x' })).status, 400, 'a reason');
    assert.equal((await post(base, s, `/api/expenses/${id}/void`, { reason: 'entered twice' })).status, 200);
    assert.equal((await post(base, s, `/api/expenses/${id}/void`, { reason: 'entered twice' })).status, 409);
    assert.equal((await patch(base, s, `/api/expenses/${id}`, { amount: 50 })).status, 409, 'a voided expense stays as it was');
    month = await get(base, s, `/api/expenses?month=${today.slice(0, 7)}`);
    assert.equal(month.total_cents, 1000, 'a voided expense counts for nothing');
    assert.equal(month.expenses.length, 2, 'and is still listed');
    const audit = (await db.query("SELECT action FROM audit_log WHERE entity_type = 'expense' ORDER BY id")).rows.map(r => r.action);
    assert.deepEqual(audit, ['expense.create', 'expense.create', 'expense.update', 'expense.void']);
  });
});

test('expenses are the owner\'s: staff get 403, and with the module switched off every route is 404', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const staff = await staffSession(base, s);
    assert.equal((await fetch(`${base}/api/expenses/meta`, { headers: staff.h })).status, 403);
    assert.equal((await post(base, staff, '/api/expenses', { spent_on: '2026-01-01', amount: 5, method: 'Cash' })).status, 403);
    assert.equal((await patch(base, s, '/api/features', { expenses: false })).status, 200);
    assert.equal((await fetch(`${base}/api/expenses/meta`, { headers: s.h })).status, 404);
  });
});

test('a receipt photo or a voice note comes back as a checked draft — nothing is saved until the owner saves it', async () => {
  await withDb(async db => {
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const base = await startApp();
      const s = await setup(base);
      const today = await todayOf(db);
      // Not set up: refused with a sentence, and typing still works.
      const off = await post(base, s, '/api/expenses/extract', { image: { mime: 'image/jpeg', data: JPEG } });
      assert.equal(off.status, 404);
      assert.match((await json(off)).error, /GEMINI_API_KEY/);

      process.env.GEMINI_API_KEY = 'test-key';
      const svc = require('../../src/services/expenses');
      const seen = [];
      svc.setProviders({ extract: async a => { seen.push(a); return a.kind === 'image'
        ? { date: '1999-01-01', supplier: ' Pasar  Borong ', total: 186.4, category: 'groceries & PRODUCE', method: 'Cash', description: 'Bawang', items: [{ name: 'Bawang 10kg', qty: 1, amount: 58 }] }
        : { date: today, supplier: 'Pasar', total: -3, category: 'Caviar', method: 'Gold', items: 'lots' }; } });

      const r = await json(await post(base, s, '/api/expenses/extract', { image: { mime: 'image/jpeg', data: JPEG } }));
      assert.equal(seen[0].kind, 'image');
      assert.ok(seen[0].categories.includes('Gas'), 'the model is told the categories');
      assert.equal(r.source, 'photo');
      assert.ok(r.receipt_id, 'the photo is kept as the receipt');
      const cats = (await get(base, s, '/api/expenses/meta')).categories;
      assert.deepEqual(r.draft, {
        spent_on: today, // a date over a year ago is not believed
        supplier: 'Pasar Borong', amount: 186.4, category_id: cats.find(c => c.name === 'Groceries & produce').id,
        method: 'Cash', description: 'Bawang', items: [{ name: 'Bawang 10kg', qty: 1, amount: 58 }],
      });
      assert.equal((await db.query('SELECT count(*)::int n FROM expenses')).rows[0].n, 0, 'nothing recorded by reading');

      // A voice note: nothing kept; anything doubtful is left for the owner.
      const v = await json(await post(base, s, '/api/expenses/extract', { audio: { mime: 'audio/webm', data: Buffer.from('voice').toString('base64') } }));
      assert.equal(v.source, 'voice');
      assert.equal(v.receipt_id, null);
      assert.equal(v.draft.amount, null, 'a negative total is not believed');
      assert.equal(v.draft.category_id, cats.find(c => c.name === 'Other').id);
      assert.equal(v.draft.method, null);
      assert.deepEqual(v.draft.items, []);

      // Saving the checked draft with its photo.
      const saved = await post(base, s, '/api/expenses', { ...r.draft, amount: 186.4, source: 'photo', receipt_id: r.receipt_id });
      assert.equal(saved.status, 201);
      const img = await fetch(`${base}/api/expenses/receipts/${r.receipt_id}`, { headers: s.h });
      assert.equal(img.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(Buffer.from(await img.arrayBuffer()), Buffer.from(JPEG, 'base64'));

      // Not a photo, or not a kind of file it reads: refused.
      assert.equal((await post(base, s, '/api/expenses/extract', { image: { mime: 'image/jpeg', data: Buffer.from('hello').toString('base64') } })).status, 400);
      assert.equal((await post(base, s, '/api/expenses/extract', { image: { mime: 'image/svg+xml', data: JPEG } })).status, 400);
      assert.equal((await post(base, s, '/api/expenses/extract', {})).status, 400);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prev;
    }
  });
});

test('regular costs: due dates by month (short months included) and by week', () => {
  const { occurrences } = require('../../src/services/expenses');
  assert.deepEqual(occurrences({ every: 'month', day: 31 }, '2026-01-15', '2026-05-01'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(occurrences({ every: 'month', day: 1 }, '2026-01-01', '2026-03-01'), ['2026-02-01', '2026-03-01']);
  // 2026-10-05 is a Monday.
  assert.deepEqual(occurrences({ every: 'week', day: 1 }, '2026-10-01', '2026-10-20'), ['2026-10-05', '2026-10-12', '2026-10-19']);
});

test('a regular cost shows as due, is recorded (or skipped) oldest first, and two phones recording it at once make one expense', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const today = await todayOf(db);
    const start = shiftDay(today, -70);
    const rent = await json(await post(base, s, '/api/expenses/recurring', { name: 'Rent', amount: 2500, method: 'Bank transfer', every: 'month', day: Number(start.slice(8, 10)), starts_on: start }));
    // starts_on is 70 days back, due on that day of each month: 3 dates due.
    let meta = await get(base, s, '/api/expenses/meta');
    const due = meta.due.find(d => d.id === rent.id);
    assert.equal(due.due_for, start);
    assert.equal(due.more, 2);

    const later = await post(base, s, `/api/expenses/recurring/${rent.id}/record`, { for: shiftDay(today, 0) });
    assert.equal(later.status, 409, 'oldest first');

    const results = await Promise.all(Array.from({ length: 10 }, () => post(base, s, `/api/expenses/recurring/${rent.id}/record`, { for: start, amount: 2600 })));
    assert.equal(results.filter(r => r.status === 200).length, 1, 'one of ten wins');
    assert.ok(results.every(r => [200, 409].includes(r.status)));
    const rows = (await db.query('SELECT amount_cents, source, recurring_for FROM expenses WHERE recurring_id = $1', [rent.id])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount_cents, 260000, 'the amount confirmed, not the template\'s');

    meta = await get(base, s, '/api/expenses/meta');
    const next = meta.due.find(d => d.id === rent.id);
    assert.notEqual(next.due_for, start);
    assert.equal((await post(base, s, `/api/expenses/recurring/${rent.id}/skip`, { for: next.due_for })).status, 200);
    assert.equal((await db.query('SELECT count(*)::int n FROM expenses WHERE recurring_id = $1', [rent.id])).rows[0].n, 1, 'a skip records nothing');

    assert.equal((await patch(base, s, `/api/expenses/recurring/${rent.id}`, { active: false })).status, 200);
    meta = await get(base, s, '/api/expenses/meta');
    assert.equal(meta.due.find(d => d.id === rent.id), undefined, 'switched off: nothing due');
  });
});

test('the Sales explorer shows the owner sales − expenses by day; staff and filtered views never see costs; Clear sales data leaves expenses alone', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const today = await todayOf(db);
    const id = await openCard(base, s, 1, one(s.mee));
    assert.equal((await post(base, s, `/api/orders/${id}/pay`, { method: 'Card' })).status, 200);
    await post(base, s, '/api/expenses', { spent_on: today, amount: 3, method: 'Cash' });
    await post(base, s, '/api/expenses', { spent_on: shiftDay(today, -1), amount: 4, method: 'Cash' });
    const voided = await json(await post(base, s, '/api/expenses', { spent_on: today, amount: 99, method: 'Cash' }));
    await post(base, s, `/api/expenses/${voided.id}/void`, { reason: 'mistake' });

    const d = await get(base, s, `/api/analytics?from=${shiftDay(today, -1)}&to=${today}&bucket=day`);
    assert.deepEqual(d.expenses, { total_cents: 700, by_bucket: true });
    assert.deepEqual(d.rows.map(r => r.expenses_cents), [400, 300]);
    const hourly = await get(base, s, `/api/analytics?from=${today}&to=${today}`);
    assert.deepEqual(hourly.expenses, { total_cents: 300, by_bucket: false });
    const filtered = await get(base, s, `/api/analytics?from=${today}&to=${today}&order_type=dine_in`);
    assert.equal(filtered.expenses, null);

    const staff = await staffSession(base, s);
    const theirs = await json(await fetch(`${base}/api/analytics?from=${today}&to=${today}`, { headers: staff.h }));
    assert.equal(theirs.expenses, null);

    // Clear sales data: sales go to RM0, expenses stay.
    const shift = await get(base, s, '/api/shift/current');
    const tickets = (await get(base, s, '/api/kitchen/tickets?station=kitchen')).tickets;
    for (const t of tickets) for (const st of ['preparing', 'ready', 'served']) await patch(base, s, `/api/kitchen/tickets/${t.id}`, { status: st });
    const rep = await get(base, s, `/api/shift/${shift.id}/report`);
    assert.equal((await post(base, s, '/api/shift/close', { counted: rep.cash.expected_cents / 100 })).status, 200);
    const cleared = await post(base, s, '/api/admin/sales/clear', { pin: '1234', confirm: 'CLEAR' });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.equal((await db.query('SELECT count(*)::int n FROM expenses')).rows[0].n, 3);
  });
});

test('the Gemini call: key in a header (never the URL), the photo inline, JSON out; a used-up free limit says so', async () => {
  const http = require('http');
  const got = [];
  let answer = 200;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      got.push({ url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(body) });
      res.writeHead(answer, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer === 200
        ? { candidates: [{ content: { parts: [{ text: '{"supplier":"Kedai Runcit Ah Seng","total":42.5,"category":"Gas","method":"Cash"}' }] } }] }
        : { error: { message: 'Resource has been exhausted' } }));
    });
  });
  await new Promise(r => srv.listen(0, r));
  const saved = { key: process.env.GEMINI_API_KEY, url: process.env.GEMINI_URL, mode: process.env.EXPENSE_AI_MODE };
  process.env.GEMINI_API_KEY = 'secret-key';
  process.env.GEMINI_URL = `http://localhost:${srv.address().port}/v1beta/models/test:generateContent`;
  delete process.env.EXPENSE_AI_MODE;
  try {
    await withDb(async () => {
      const base = await startApp();
      const s = await setup(base);
      const r = await json(await post(base, s, '/api/expenses/extract', { image: { mime: 'image/jpeg', data: JPEG } }));
      assert.equal(r.draft.supplier, 'Kedai Runcit Ah Seng');
      assert.equal(r.draft.amount, 42.5);
      assert.equal(got[0].key, 'secret-key');
      assert.doesNotMatch(got[0].url, /secret-key/);
      const parts = got[0].body.contents[0].parts;
      assert.match(parts[0].text, /mamak restaurant/);
      assert.deepEqual(parts[1].inline_data, { mime_type: 'image/jpeg', data: JPEG });
      assert.equal(got[0].body.generationConfig.responseMimeType, 'application/json');

      answer = 429;
      const limited = await post(base, s, '/api/expenses/extract', { image: { mime: 'image/jpeg', data: JPEG } });
      assert.equal(limited.status, 502);
      assert.match((await json(limited)).error, /free reading limit/);
    });
  } finally {
    srv.close();
    for (const [k, env] of [['key', 'GEMINI_API_KEY'], ['url', 'GEMINI_URL'], ['mode', 'EXPENSE_AI_MODE']]) {
      if (saved[k] === undefined) delete process.env[env]; else process.env[env] = saved[k];
    }
  }
});


test('F5: a photo saved as an expense is never lost to the clean-up of day-old photos, and belongs to one expense', async () => {
  await withDb(async db => {
    process.env.EXPENSE_AI_MODE = 'mock';
    try {
      const base = await startApp();
      const s = await setup(base);
      const today = await todayOf(db);
      for (let i = 0; i < 20; i++) {
        const r = await json(await post(base, s, '/api/expenses/extract', { image: { mime: 'image/jpeg', data: JPEG } }));
        // The draft has been open over a day.
        await db.query("UPDATE expense_receipts SET created_at = now() - interval '2 days' WHERE id = $1", [r.receipt_id]);
        const [saved] = await Promise.all([
          post(base, s, '/api/expenses', { spent_on: today, amount: 10, method: 'Cash', source: 'photo', receipt_id: r.receipt_id }),
          post(base, s, '/api/expenses/extract', { image: { mime: 'image/jpeg', data: JPEG } }), // runs the clean-up
        ]);
        assert.ok([201, 400].includes(saved.status), `run ${i}: ${saved.status} ${await saved.clone().text()}`);
        if (saved.status === 201) {
          const { id } = await json(saved);
          const row = (await db.query('SELECT receipt_id FROM expenses WHERE id = $1', [id])).rows[0];
          assert.equal(row.receipt_id, r.receipt_id, `run ${i}: the saved expense kept its photo`);
          assert.ok((await db.query('SELECT 1 FROM expense_receipts WHERE id = $1', [r.receipt_id])).rows[0], `run ${i}: and the photo is there`);
        } else {
          assert.match((await json(saved)).error, /no longer here/);
        }
      }
      // One photo, one expense.
      const r = await json(await post(base, s, '/api/expenses/extract', { image: { mime: 'image/jpeg', data: JPEG } }));
      const body = { spent_on: today, amount: 10, method: 'Cash', source: 'photo', receipt_id: r.receipt_id };
      const both = await Promise.all([post(base, s, '/api/expenses', body), post(base, s, '/api/expenses', body)]);
      assert.deepEqual(both.map(x => x.status).sort(), [201, 409]);
    } finally { delete process.env.EXPENSE_AI_MODE; }
  });
});

test('nonsense is refused with a sentence: odd sen, ancient dates, impossible months, a receipt id that is not one', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const today = await todayOf(db);
    const bad = async (pending, re) => {
      const r = await pending;
      assert.equal(r.status, 400, await r.clone().text());
      assert.match((await json(r)).error, re);
    };
    await bad(post(base, s, '/api/expenses', { spent_on: today, amount: 1.005, method: 'Cash' }), /two decimal places/);
    await bad(post(base, s, '/api/expenses', { spent_on: '1900-01-01', amount: 1, method: 'Cash' }), /five years ago/);
    await bad(post(base, s, '/api/expenses', { spent_on: today, amount: 1, method: 'Cash', receipt_id: 'abc' }), /not one of ours/);
    await bad(post(base, s, '/api/expenses', { spent_on: today, amount: 1, method: 'Cash', receipt_id: 1.5 }), /not one of ours/);
    for (const m of ['2026-13', '2026-00', 'soon']) await bad(fetch(`${base}/api/expenses?month=${m}`, { headers: s.h }), /YYYY-MM/);
    await bad(post(base, s, '/api/expenses/recurring', { name: 'Old', amount: 5, every: 'month', day: 1, starts_on: '1900-01-01' }), /within a year/);
    assert.equal((await post(base, s, '/api/expenses', { spent_on: today, amount: 12.5, method: 'Cash' })).status, 201);
  });
});

test('upgrading: a set-up shop gets Expenses on, but a "Small stall" shop that chose nothing keeps it off', async () => {
  await withDb(async db => {
    const flag = async () => (await db.query("SELECT value FROM settings WHERE key = 'feature_expenses'")).rows[0]?.value;
    const upgradeAs = async features => {
      await db.query("DELETE FROM settings WHERE key LIKE 'feature%' OR key = 'setup_completed'");
      await db.query("INSERT INTO settings (key, value) VALUES ('setup_completed', '1')");
      for (const [m, v] of Object.entries(features)) await db.query('INSERT INTO settings (key, value) VALUES ($1, $2)', [`feature_${m}`, v]);
      await db.query("DELETE FROM schema_migrations WHERE version = '021_expenses.sql'");
      await db.migrate();
    };
    await upgradeAs({ kitchen: '0', printing: '0', shifts: '0', dashboard: '0' });
    assert.equal(await flag(), '0', 'Small stall: off');
    await upgradeAs({ kitchen: '1', printing: '0', dashboard: '1' });
    assert.equal(await flag(), '1', 'a shop using modules: on');
    // A fresh install (no setup yet) is left to the wizard.
    await db.query("DELETE FROM settings WHERE key LIKE 'feature%' OR key = 'setup_completed'");
    await db.query("DELETE FROM schema_migrations WHERE version = '021_expenses.sql'");
    await db.migrate();
    assert.equal(await flag(), undefined);
  });
});
