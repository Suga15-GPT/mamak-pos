const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb, getFreePort } = require('../helper');

const SRC_DIR = path.join(__dirname, '..', '..', 'src') + path.sep;
const DB_MODULE = require.resolve('../../src/db');
const SERVER_MODULE = require.resolve('../../src/server');

function clearSrcCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_DIR) && key !== DB_MODULE) delete require.cache[key];
  }
}

async function waitReady(base, retries = 50) {
  for (let i = 0; i < retries; i++) {
    try { await fetch(`${base}/api/menu`); return; }
    catch { await new Promise(r => setTimeout(r, 100)); }
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

async function setup(base) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Admin', pin: '1234' }),
  });
  const body = await json(r);
  const headers = { cookie: (r.headers.get('set-cookie') || '').split(';')[0], 'x-csrf-token': body.csrf_token, 'content-type': 'application/json' };
  await fetch(`${base}/api/shift/open`, { method: 'POST', headers, body: JSON.stringify({ float: 0 }) });
  return headers;
}

const api = {
  get: (base, h, p) => fetch(`${base}${p}`, { headers: h }).then(json),
  post: (base, h, p, b) => fetch(`${base}${p}`, { method: 'POST', headers: h, body: JSON.stringify(b || {}) }),
  patch: (base, h, p, b) => fetch(`${base}${p}`, { method: 'PATCH', headers: h, body: JSON.stringify(b || {}) }),
  del: (base, h, p) => fetch(`${base}${p}`, { method: 'DELETE', headers: h }),
};

const menu = (base, h) => api.get(base, h, '/api/admin/menu');

/* Master spec §58 */
test('menu item: create, edit, sold out today, restore, deactivate, safe delete', async () => {
  await withDb(async () => {
    const base = await startApp();
    const h = await setup(base);
    const cats = (await menu(base, h)).categories;

    const created = await api.post(base, h, '/api/admin/items',
      { name: 'Test Mee', price: 7.5, category_id: cats[0].id, station_code: 'kitchen' });
    assert.equal(created.status, 200);
    const { id } = await json(created);

    let it = (await menu(base, h)).items.find(i => i.id === id);
    assert.equal(it.name, 'Test Mee');
    assert.equal(it.price_cents, 750, 'money stays integer cents');
    assert.equal(it.station_code, 'kitchen');

    // Edit, including moving it to another preparation station.
    assert.equal((await api.patch(base, h, `/api/admin/items/${id}`,
      { name: 'Test Mee Goreng', price: 8.9, station_code: 'drinks' })).status, 200);
    it = (await menu(base, h)).items.find(i => i.id === id);
    assert.equal(it.name, 'Test Mee Goreng');
    assert.equal(it.price_cents, 890);
    assert.equal(it.station_code, 'drinks');

    // Sold out today, and the till stops offering it.
    assert.equal((await api.patch(base, h, `/api/admin/items/${id}`, { sold_out_today: true })).status, 200);
    assert.ok((await menu(base, h)).items.find(i => i.id === id).sold_out_until);
    assert.equal((await api.get(base, h, '/api/menu')).items.some(i => i.id === id), false);

    // Restored.
    await api.patch(base, h, `/api/admin/items/${id}`, { sold_out_today: false });
    assert.equal((await api.get(base, h, '/api/menu')).items.some(i => i.id === id), true);

    // Deactivated indefinitely — a different concept, kept separate.
    await api.patch(base, h, `/api/admin/items/${id}`, { available: false });
    assert.equal((await api.get(base, h, '/api/menu')).items.some(i => i.id === id), false);
    await api.patch(base, h, `/api/admin/items/${id}`, { available: true });

    // Safe delete: refused while it sits on a live order…
    const tables = await api.get(base, h, '/api/tables');
    const order = await json(await api.post(base, h, '/api/orders',
      { table_id: tables[0].id, items: [{ item_id: id, qty: 1 }] }));
    const refused = await api.del(base, h, `/api/admin/items/${id}`);
    assert.equal(refused.status, 409);
    assert.match((await json(refused)).error, /still open/i);

    // …and allowed once that order is closed, with the bill keeping its own copy.
    await api.post(base, h, `/api/orders/${order.id}/pay`, { method: 'Cash' });
    assert.equal((await api.del(base, h, `/api/admin/items/${id}`)).status, 200);
    assert.equal((await menu(base, h)).items.some(i => i.id === id), false);

    const historical = (await api.get(base, h, '/api/orders?mode=recent')).find(o => o.id === order.id);
    assert.equal(historical.items[0].name, 'Test Mee Goreng', 'history keeps its own snapshot');
    assert.equal(historical.items[0].price, 8.9);
  });
});

test('modifier group: create, rename, constraints, attach, detach, duplicate, safe delete', async () => {
  await withDb(async () => {
    const base = await startApp();
    const h = await setup(base);

    const { id: groupId } = await json(await api.post(base, h, '/api/admin/modifier_groups',
      { name: 'Test Sauce', mode: 'radio' }));
    let g = (await menu(base, h)).modifier_groups.find(x => x.id === groupId);
    assert.equal(g.min_select, 1);
    assert.equal(g.max_select, 1);

    await api.patch(base, h, `/api/admin/modifier_groups/${groupId}`,
      { name: 'Sauce', mode: 'checkbox', min_select: 1, max_select: 3 });
    g = (await menu(base, h)).modifier_groups.find(x => x.id === groupId);
    assert.equal(g.name, 'Sauce');
    assert.equal(g.max_select, 3);

    // A minimum above the maximum can never be satisfied and would only show up
    // as an un-orderable item at the till, so it is corrected on the way in.
    await api.patch(base, h, `/api/admin/modifier_groups/${groupId}`, { min_select: 5 });
    g = (await menu(base, h)).modifier_groups.find(x => x.id === groupId);
    assert.equal(g.max_select, 5);

    const item = (await menu(base, h)).items[0];
    assert.equal((await api.post(base, h, '/api/admin/item_modifier_groups',
      { item_id: item.id, group_id: groupId })).status, 200);
    assert.ok((await menu(base, h)).item_modifier_groups
      .some(ig => ig.item_id === item.id && ig.group_id === groupId));

    // Deleting a group that items still use needs an explicit confirmation, and
    // says which items would lose their options.
    const blocked = await api.del(base, h, `/api/admin/modifier_groups/${groupId}`);
    assert.equal(blocked.status, 409);
    const blockedBody = await json(blocked);
    assert.equal(blockedBody.needs_confirm, true);
    assert.deepEqual(blockedBody.attached_items, [item.name]);

    assert.equal((await api.del(base, h, `/api/admin/item_modifier_groups/${item.id}/${groupId}`)).status, 200);
    assert.equal((await menu(base, h)).item_modifier_groups
      .some(ig => ig.item_id === item.id && ig.group_id === groupId), false);

    await api.post(base, h, '/api/admin/modifier_options', { group_id: groupId, name: 'Chilli', price: 1 });
    const { id: copyId } = await json(await api.post(base, h, `/api/admin/modifier_groups/${groupId}/duplicate`));
    const after = await menu(base, h);
    assert.equal(after.modifier_groups.find(x => x.id === copyId).name, 'Sauce (copy)');
    assert.deepEqual(after.modifier_options.filter(o => o.group_id === copyId).map(o => o.name), ['Chilli']);

    assert.equal((await api.del(base, h, `/api/admin/modifier_groups/${groupId}`)).status, 200);
    const gone = await menu(base, h);
    assert.equal(gone.modifier_groups.some(x => x.id === groupId), false);
    assert.equal(gone.modifier_options.some(o => o.group_id === groupId), false, 'its options go with it');
  });
});

test('modifier option: create, rename, price, availability, reorder, delete — history untouched', async () => {
  await withDb(async () => {
    const base = await startApp();
    const h = await setup(base);
    const before = await menu(base, h);
    const group = before.modifier_groups.find(g => g.name === 'Extra Lauk');
    const item = before.items.find(i => i.kandar);
    const existing = before.modifier_options.find(o => o.group_id === group.id);

    // Order it once, so there is history to protect.
    const kuah = before.modifier_groups.find(g => g.name === 'Kuah');
    const kuahOpt = before.modifier_options.find(o => o.group_id === kuah.id);
    const tables = await api.get(base, h, '/api/tables');
    const order = await json(await api.post(base, h, '/api/orders', {
      table_id: tables[0].id,
      items: [{ item_id: item.id, qty: 1, modifier_option_ids: [kuahOpt.id, existing.id] }],
    }));

    const { id: optId } = await json(await api.post(base, h, '/api/admin/modifier_options',
      { group_id: group.id, name: 'Petai', price: 3 }));
    let o = (await menu(base, h)).modifier_options.find(x => x.id === optId);
    assert.equal(o.price_cents, 300);
    assert.equal(o.available, true);

    await api.patch(base, h, `/api/admin/modifier_options/${optId}`, { name: 'Petai Goreng', price: 3.5, available: false });
    o = (await menu(base, h)).modifier_options.find(x => x.id === optId);
    assert.equal(o.name, 'Petai Goreng');
    assert.equal(o.price_cents, 350);
    assert.equal(o.available, false);
    assert.equal((await api.get(base, h, '/api/menu')).modifier_options.some(x => x.id === optId), false,
      'an unavailable option is not offered');

    await api.patch(base, h, `/api/admin/modifier_options/${optId}`, { sort: -1 });
    assert.equal((await menu(base, h)).modifier_options.filter(x => x.group_id === group.id)[0].id, optId);

    // Deleting the option the historical order used must not rewrite that bill.
    assert.equal((await api.del(base, h, `/api/admin/modifier_options/${existing.id}`)).status, 200);
    const historical = (await api.get(base, h, '/api/orders?mode=recent')).find(x => x.id === order.id);
    assert.ok(historical.items[0].mods.some(m => m.name === existing.name),
      'the bill keeps its own snapshot of the option name and price');
  });
});

test('category: create, rename, reorder, and a delete that refuses to orphan items', async () => {
  await withDb(async () => {
    const base = await startApp();
    const h = await setup(base);

    const { id } = await json(await api.post(base, h, '/api/admin/categories', { name: 'Specials' }));
    assert.ok((await menu(base, h)).categories.some(c => c.id === id));

    await api.patch(base, h, `/api/admin/categories/${id}`, { name: 'Today Specials', sort: -1 });
    const cats = (await menu(base, h)).categories;
    assert.equal(cats[0].id, id);
    assert.equal(cats[0].name, 'Today Specials');

    // Empty: deletable.
    assert.equal((await api.del(base, h, `/api/admin/categories/${id}`)).status, 200);

    // Not empty: refused, rather than silently orphaning items into a bucket
    // the till cannot display.
    const withItems = (await menu(base, h)).categories.find(c => c.name === 'Roti');
    const blocked = await api.del(base, h, `/api/admin/categories/${withItems.id}`);
    assert.equal(blocked.status, 409);
    assert.match((await json(blocked)).error, /still has \d+ item/i);
  });
});

test('menu edits push a realtime event so every till drops a sold-out item at once', async () => {
  await withDb(async () => {
    const base = await startApp();
    const h = await setup(base);
    const item = (await menu(base, h)).items[0];

    const events = [];
    const controller = new AbortController();
    const streamed = fetch(`${base}/api/stream`, { headers: h, signal: controller.signal }).then(async res => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        if (chunk.includes('menu.updated')) { events.push('menu.updated'); break; }
      }
    }).catch(() => {});

    await new Promise(r => setTimeout(r, 300));
    await api.patch(base, h, `/api/admin/items/${item.id}`, { sold_out_today: true });
    await streamed;
    controller.abort();
    assert.deepEqual(events, ['menu.updated']);
  });
});
