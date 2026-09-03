const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb } = require('../helper');
const { buildOrderItems } = require('../../src/services/orders');

// A self-contained fixture (its own category/items/groups) rather than the
// seeded demo menu, so each boundary case is exact and doesn't depend on
// what seed.js happens to contain.
async function fixture(db) {
  const catId = (await db.query("INSERT INTO categories (name) VALUES ('Test Cat') RETURNING id")).rows[0].id;

  const radioGroupId = (await db.query(
    "INSERT INTO modifier_groups (name, mode, min_select, max_select) VALUES ('Kuah', 'radio', 1, 1) RETURNING id")).rows[0].id;
  const checkboxGroupId = (await db.query(
    "INSERT INTO modifier_groups (name, mode, min_select, max_select) VALUES ('Extras', 'checkbox', 0, 3) RETURNING id")).rows[0].id;

  const radioOptA = (await db.query(
    "INSERT INTO modifier_options (group_id, name, price_cents, available) VALUES ($1,'Kuah A',0,true) RETURNING id", [radioGroupId])).rows[0].id;
  const radioOptB = (await db.query(
    "INSERT INTO modifier_options (group_id, name, price_cents, available) VALUES ($1,'Kuah B',0,true) RETURNING id", [radioGroupId])).rows[0].id;

  const checkboxOptIds = [];
  for (let i = 0; i < 5; i++) {
    const r = await db.query(
      "INSERT INTO modifier_options (group_id, name, price_cents, available) VALUES ($1,$2,50,true) RETURNING id",
      [checkboxGroupId, `Extra ${i}`]);
    checkboxOptIds.push(r.rows[0].id);
  }

  const itemId = (await db.query(
    "INSERT INTO items (category_id, name, price_cents, kandar, available) VALUES ($1,'Configurable Item',1000,false,true) RETURNING id",
    [catId])).rows[0].id;
  await db.query('INSERT INTO item_modifier_groups (item_id, group_id) VALUES ($1,$2),($1,$3)', [itemId, radioGroupId, checkboxGroupId]);

  const plainItemId = (await db.query(
    "INSERT INTO items (category_id, name, price_cents, kandar, available) VALUES ($1,'Plain Item',500,false,true) RETURNING id",
    [catId])).rows[0].id;

  // exactly what the pre-phase-04 migration backfilled onto every kandar item
  const kandarItemId = (await db.query(
    "INSERT INTO items (category_id, name, price_cents, kandar, available) VALUES ($1,'Nasi Kandar Test',1200,true,true) RETURNING id",
    [catId])).rows[0].id;
  await db.query('INSERT INTO item_modifier_groups (item_id, group_id) VALUES ($1,$2),($1,$3)', [kandarItemId, radioGroupId, checkboxGroupId]);

  const soldOutTodayId = (await db.query(
    `INSERT INTO items (category_id, name, price_cents, kandar, available, sold_out_until)
     VALUES ($1,'86d Item',500,false,true,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) RETURNING id`,
    [catId])).rows[0].id;

  return { itemId, plainItemId, kandarItemId, soldOutTodayId, radioOptA, radioOptB, checkboxOptIds };
}

async function expectReject(promise, pattern) {
  await assert.rejects(promise, e => {
    assert.equal(e.status, 400);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

test('radio group: 0 selected -> 400, 1 -> ok, 2 -> 400', async () => {
  await withDb(async db => {
    const f = await fixture(db);

    await expectReject(
      buildOrderItems(db, [{ item_id: f.itemId, qty: 1, modifier_option_ids: [] }]),
      /Kuah: choose exactly 1/);

    const oneSelected = await buildOrderItems(db, [{ item_id: f.itemId, qty: 1, modifier_option_ids: [f.radioOptA] }]);
    assert.equal(oneSelected.length, 1);

    await expectReject(
      buildOrderItems(db, [{ item_id: f.itemId, qty: 1, modifier_option_ids: [f.radioOptA, f.radioOptB] }]),
      /Kuah: choose exactly 1/);
  });
});

test('checkbox group max_select=3: 4 selected -> 400', async () => {
  await withDb(async db => {
    const f = await fixture(db);

    await expectReject(
      buildOrderItems(db, [{ item_id: f.itemId, qty: 1, modifier_option_ids: [f.radioOptA, ...f.checkboxOptIds.slice(0, 4)] }]),
      /Extras: choose at most 3/);

    const ok = await buildOrderItems(db, [{ item_id: f.itemId, qty: 1, modifier_option_ids: [f.radioOptA, ...f.checkboxOptIds.slice(0, 3)] }]);
    assert.equal(ok[0].mods.length, 4); // 1 kuah + 3 extras
  });
});

test('option from a group not attached to the item -> 400', async () => {
  await withDb(async db => {
    const f = await fixture(db);
    await expectReject(
      buildOrderItems(db, [{ item_id: f.plainItemId, qty: 1, modifier_option_ids: [f.radioOptA] }]),
      /not offered on Plain Item/);
  });
});

test('item sold out today -> 400; the same item tomorrow -> 200', async () => {
  await withDb(async db => {
    const f = await fixture(db);

    await expectReject(buildOrderItems(db, [{ item_id: f.soldOutTodayId, qty: 1 }]));

    // sold_out_until in the past = the reset already happened: back on the menu
    await db.query(
      "UPDATE items SET sold_out_until = (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date - 1 WHERE id = $1", [f.soldOutTodayId]);
    const ok = await buildOrderItems(db, [{ item_id: f.soldOutTodayId, qty: 1 }]);
    assert.equal(ok.length, 1);
  });
});

test("post-migration parity: a kandar item still accepts today's payload shape", async () => {
  await withDb(async db => {
    const f = await fixture(db);
    // exactly the shape the staff/customer UI has always sent for a kandar item:
    // one kuah radio option plus zero or more checkbox extras
    const parsed = await buildOrderItems(db, [{
      item_id: f.kandarItemId, qty: 1,
      modifier_option_ids: [f.radioOptA, f.checkboxOptIds[0], f.checkboxOptIds[1]],
    }]);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].mods.length, 3);
  });
});
