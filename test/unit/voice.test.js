const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb, getFreePort } = require('../helper');

/* ===== SPEAK TO ORDER =====
   These tests are aimed squarely at the deterministic layer, because that is
   the layer that decides anything. The model is replaced by a stub that returns
   whatever a test wants it to return — including hallucinated ids, sold-out
   items and invented prices — and the point of each case is that the POS, not
   the stub, has the last word.

   The stub also stands in for the transcription vendor. Nothing here reaches a
   network, and nothing here needs an API key. */

const SRC_DIR = path.join(__dirname, '..', '..', 'src') + path.sep;
const DB_MODULE = require.resolve('../../src/db');
const SERVER_MODULE = require.resolve('../../src/server');
const VOICE_MODULE = require.resolve('../../src/services/voice');

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

/* Boots the app with voice switched on and both vendors stubbed out. */
async function startApp({ transcript = 'anything', propose = () => ({ understood: true, items: [], clarification: '' }) } = {}) {
  const port = await getFreePort();
  process.env.PORT = String(port);
  process.env.ADMIN_PIN = '1234';
  process.env.VOICE_ORDERING = '1';
  process.env.VOICE_MODE = 'live';
  process.env.VOICE_STT_URL = 'http://stub.invalid/transcribe';
  process.env.VOICE_STT_API_KEY = 'stub';
  process.env.ANTHROPIC_API_KEY = 'stub';
  clearSrcCache();
  require(SERVER_MODULE);
  const voice = require(VOICE_MODULE);
  voice.resetMenuSnapshot();
  const calls = { transcribe: 0, interpret: 0, lastDraftText: null, lastMenuText: null };
  voice.setProviders({
    transcribe: async () => { calls.transcribe++; return transcript; },
    interpret: async args => {
      calls.interpret++;
      calls.lastDraftText = args.draftText;
      calls.lastMenuText = args.menuText;
      return propose(args);
    },
  });
  const base = `http://localhost:${port}`;
  await waitReady(base);
  return { base, voice, calls };
}

const json = res => res.json();

async function login(base, name, pin) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin }),
  });
  const body = await json(r);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrfToken: body.csrf_token };
}
const auth = s => ({ cookie: s.cookie, 'x-csrf-token': s.csrfToken, 'content-type': 'application/json' });

async function setup(base) {
  const adminAuth = auth(await login(base, 'Admin', '1234'));
  const menu = await json(await fetch(`${base}/api/menu`, { headers: adminAuth }));
  const tables = await json(await fetch(`${base}/api/admin/tables`, { headers: adminAuth }));
  const byName = n => menu.items.find(i => i.name === n);
  return {
    adminAuth, menu, tables,
    token: tables[0].qr_token, tableId: tables[0].id, tableName: tables[0].name,
    mee: byName('Mee Goreng Mamak'), teh: byName('Teh Tarik'), roti: byName('Roti Canai'),
    kandar: menu.items.find(i => (i.modifier_group_ids || []).length > 0),
  };
}

// Anything over the 1500-byte "that was a tap, not a sentence" floor the page
// applies; the server only cares that it is a plausible audio payload.
const AUDIO = Buffer.alloc(4096, 7).toString('base64');

const speak = (base, token, extra = {}) => fetch(`${base}/api/public/voice/interpret`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ table_token: token, mime_type: 'audio/webm', audio_base64: AUDIO, ...extra }),
});

const confirm = (base, token, items) => fetch(`${base}/api/public/orders`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ table_token: token, items }),
});

// What the customer's Confirm button actually sends: ids and quantities, never
// a price.
const asSubmission = lines => lines.map(l => ({
  item_id: l.item_id, qty: l.qty, note: l.note,
  modifier_option_ids: l.mods.map(m => m.id),
}));

/* ---------------------------------------------------------------- */

test('a valid proposal becomes a priced preview, and the prices are the POS\'s own', async () => {
  await withDb(async () => {
    let s;
    const { base } = await startApp({
      transcript: 'roti canai dua, teh tarik satu',
      propose: () => ({
        understood: true,
        items: [
          { menu_item_id: s.roti.id, quantity: 2, modifier_option_ids: [], note: '' },
          { menu_item_id: s.teh.id, quantity: 1, modifier_option_ids: [], note: 'kurang manis' },
        ],
        clarification: '',
      }),
    });
    s = await setup(base);

    const body = await json(await speak(base, s.token));
    assert.equal(body.understood, true);
    assert.equal(body.lines.length, 2);

    const [roti, teh] = body.lines;
    assert.equal(roti.name, s.roti.name);
    assert.equal(roti.qty, 2);
    assert.equal(roti.unit_price, s.roti.price, 'unit price comes from items.price_cents');
    assert.equal(roti.line_total, Math.round(s.roti.price * 2 * 100) / 100);
    assert.equal(teh.note, 'kurang manis', 'how the customer wants it made survives');
    assert.equal(body.subtotal, Math.round((s.roti.price * 2 + s.teh.price) * 100) / 100);
    assert.equal(body.transcript, 'roti canai dua, teh tarik satu');
  });
});

test('an item the model invented is refused, not billed', async () => {
  await withDb(async () => {
    let s;
    const { base } = await startApp({
      propose: () => ({
        understood: true,
        items: [
          { menu_item_id: 999999, quantity: 1, modifier_option_ids: [], note: '' },
          { menu_item_id: s.teh.id, quantity: 1, modifier_option_ids: [], note: '' },
        ],
        clarification: '',
      }),
    });
    s = await setup(base);

    const body = await json(await speak(base, s.token));
    assert.equal(body.lines.length, 1, 'only the real item survives');
    assert.equal(body.lines[0].item_id, s.teh.id);
    assert.deepEqual(body.rejected, [{ reason: 'unknown', name: null }]);
  });
});

test('a sold-out item is named and refused, so the customer is told why', async () => {
  await withDb(async () => {
    let s;
    const { base } = await startApp({
      propose: () => ({
        understood: true,
        items: [{ menu_item_id: s.teh.id, quantity: 1, modifier_option_ids: [], note: '' }],
        clarification: '',
      }),
    });
    s = await setup(base);

    const soldOut = await fetch(`${base}/api/admin/items/${s.teh.id}`, {
      method: 'PATCH', headers: s.adminAuth, body: JSON.stringify({ sold_out_today: true }),
    });
    assert.equal(soldOut.status, 200);
    // The snapshot is cached for a minute; sold-out has to bite immediately,
    // which it does because validation reads the database, not the snapshot.

    const body = await json(await speak(base, s.token));
    assert.equal(body.understood, false, 'nothing left to confirm');
    assert.equal(body.lines.length, 0);
    assert.deepEqual(body.rejected, [{ reason: 'sold_out', name: s.teh.name }]);

    // And the confirm path refuses it too, even if a phone tried anyway.
    const forced = await confirm(base, s.token, [{ item_id: s.teh.id, qty: 1 }]);
    assert.equal(forced.status, 400);
  });
});

test('a price the model invents is ignored — there is nowhere for it to land', async () => {
  await withDb(async () => {
    let s;
    const { base } = await startApp({
      propose: () => ({
        understood: true,
        // Every one of these extra fields is a lie, and none of them is read.
        items: [{
          menu_item_id: s.roti.id, quantity: 1, modifier_option_ids: [], note: '',
          price: 0.01, unit_price: 0.01, line_total: 0.01, total: 0.01, discount: 99,
        }],
        clarification: '', subtotal: 0.01, total: 0.01, tax: 0,
      }),
    });
    s = await setup(base);

    const body = await json(await speak(base, s.token));
    assert.equal(body.lines[0].unit_price, s.roti.price);
    assert.equal(body.lines[0].line_total, s.roti.price);
    assert.equal(body.subtotal, s.roti.price);
    assert.equal(body.lines[0].price, undefined, 'no model-supplied field is echoed back');
    assert.equal(body.discount, undefined);
  });
});

test('quantities and notes are clamped and cleaned, whatever the model returned', async () => {
  await withDb(async () => {
    let s;
    const { base } = await startApp({
      propose: () => ({
        understood: true,
        items: [
          { menu_item_id: s.roti.id, quantity: 9999, modifier_option_ids: [], note: 'x'.repeat(500) },
          { menu_item_id: s.teh.id, quantity: -3, modifier_option_ids: [], note: `a${String.fromCharCode(0)}b` },
          { menu_item_id: s.mee.id, quantity: 'lots', modifier_option_ids: [], note: null },
        ],
        clarification: '',
      }),
    });
    s = await setup(base);

    const body = await json(await speak(base, s.token));
    assert.equal(body.lines[0].qty, 20, 'clamped to the per-line maximum');
    assert.equal(body.lines[0].note.length, 200, 'the note is truncated');
    assert.equal(body.lines[1].qty, 1, 'a negative quantity becomes one');
    assert.equal(body.lines[1].note, 'a b', 'control characters are flattened');
    assert.equal(body.lines[2].qty, 1, 'a non-numeric quantity becomes one');
    assert.equal(body.lines[2].note, '');
  });
});

test('an option the item does not offer is dropped, and the line asks the question instead', async () => {
  await withDb(async () => {
    let s, foreignOptionId;
    const { base } = await startApp({
      propose: () => ({
        understood: true,
        items: [{ menu_item_id: s.kandar.id, quantity: 1, modifier_option_ids: [foreignOptionId], note: '' }],
        clarification: '',
      }),
    });
    s = await setup(base);

    // A group this dish does not carry: "Ais" belongs to the drinks, and asking
    // for it on a nasi kandar is the shape of a mishearing.
    const group = await json(await fetch(`${base}/api/admin/modifier_groups`, {
      method: 'POST', headers: s.adminAuth,
      body: JSON.stringify({ name: 'Ais', mode: 'radio', min_select: 1, max_select: 1 }),
    }));
    const option = await json(await fetch(`${base}/api/admin/modifier_options`, {
      method: 'POST', headers: s.adminAuth,
      body: JSON.stringify({ group_id: group.id, name: 'Tak nak ais', price: 0 }),
    }));
    foreignOptionId = option.id;
    assert.ok(foreignOptionId, 'the foreign option exists but is attached to no dish');

    const body = await json(await speak(base, s.token));
    const line = body.lines[0];
    assert.deepEqual(line.mods, [], 'the option is not attached to this dish, so it is dropped');
    assert.equal(line.unit_price, s.kandar.price, 'and it certainly does not change the price');
    assert.ok(line.needs_choice.length > 0, 'the unanswered group is surfaced as a question');
  });
});

test('a valid option is priced from the database and completes the line', async () => {
  await withDb(async () => {
    let s, optionId;
    const { base } = await startApp({
      propose: () => ({
        understood: true,
        items: [{ menu_item_id: s.kandar.id, quantity: 2, modifier_option_ids: [optionId], note: '' }],
        clarification: '',
      }),
    });
    s = await setup(base);
    const groupId = s.kandar.modifier_group_ids[0];
    const opt = s.menu.modifier_options.find(o => o.group_id === groupId);
    optionId = opt.id;

    const body = await json(await speak(base, s.token));
    const line = body.lines[0];
    assert.deepEqual(line.mods.map(m => m.name), [opt.name]);
    assert.equal(line.unit_price, Math.round((s.kandar.price + opt.price) * 100) / 100);
    assert.equal(line.line_total, Math.round((s.kandar.price + opt.price) * 2 * 100) / 100);
  });
});

test('a preview the customer never confirms creates nothing at all', async () => {
  await withDb(async () => {
    let s;
    const { base } = await startApp({
      propose: () => ({
        understood: true,
        items: [{ menu_item_id: s.roti.id, quantity: 3, modifier_option_ids: [], note: '' }],
        clarification: '',
      }),
    });
    s = await setup(base);

    const body = await json(await speak(base, s.token));
    assert.equal(body.lines.length, 1);

    // The customer looks at it and walks away. This is the whole point of the
    // architecture: interpretation is not a mutation.
    const orders = await json(await fetch(`${base}/api/orders`, { headers: s.adminAuth }));
    assert.equal(orders.length, 0, 'no dining order');
    const tickets = await json(await fetch(`${base}/api/kitchen/tickets?station=kitchen`, { headers: s.adminAuth }));
    assert.equal(tickets.tickets.length, 0, 'nothing reached the kitchen');
  });
});

test('confirming a spoken order creates the ordinary dining order and round 1', async () => {
  await withDb(async () => {
    let s;
    const { base } = await startApp({
      propose: () => ({
        understood: true,
        items: [
          { menu_item_id: s.roti.id, quantity: 2, modifier_option_ids: [], note: 'banjir' },
          { menu_item_id: s.teh.id, quantity: 1, modifier_option_ids: [], note: '' },
        ],
        clarification: '',
      }),
    });
    s = await setup(base);

    const preview = await json(await speak(base, s.token));
    const sent = await confirm(base, s.token, asSubmission(preview.lines));
    assert.equal(sent.status, 201);
    const sentBody = await json(sent);
    assert.equal(sentBody.round, 1);
    assert.ok(sentBody.ref);

    const orders = await json(await fetch(`${base}/api/orders`, { headers: s.adminAuth }));
    assert.equal(orders.length, 1);
    const order = orders[0];
    assert.equal(order.source, 'qr', 'a spoken order is a QR order — no separate data model');
    assert.equal(order.sends.length, 1);
    assert.deepEqual(order.items.map(i => i.name).sort(), [s.roti.name, s.teh.name].sort());
    assert.equal(order.subtotal, Math.round((s.roti.price * 2 + s.teh.price) * 100) / 100,
      'the bill is the POS total, computed from its own prices');
    assert.equal(order.items.find(i => i.name === s.roti.name).note, 'banjir');
  });
});

test('ordering more by voice opens a NEW kitchen round and leaves the served one alone', async () => {
  await withDb(async () => {
    let s, wanted = [];
    const { base } = await startApp({
      propose: () => ({ understood: true, items: wanted, clarification: '' }),
    });
    s = await setup(base);

    // Round 1, spoken and confirmed, then run all the way to served.
    wanted = [{ menu_item_id: s.roti.id, quantity: 1, modifier_option_ids: [], note: '' }];
    const first = await json(await speak(base, s.token));
    await confirm(base, s.token, asSubmission(first.lines));

    const tickets = await json(await fetch(`${base}/api/kitchen/tickets?station=kitchen`, { headers: s.adminAuth }));
    const ticketId = tickets.tickets[0].id;
    for (const status of ['preparing', 'ready', 'served']) {
      const r = await fetch(`${base}/api/kitchen/tickets/${ticketId}`, {
        method: 'PATCH', headers: s.adminAuth, body: JSON.stringify({ status }),
      });
      assert.equal(r.status, 200);
    }

    // Round 2, spoken at the same table.
    wanted = [{ menu_item_id: s.teh.id, quantity: 2, modifier_option_ids: [], note: '' }];
    const second = await json(await speak(base, s.token));
    const sent = await json(await confirm(base, s.token, asSubmission(second.lines)));
    assert.equal(sent.round, 2);

    const orders = await json(await fetch(`${base}/api/orders`, { headers: s.adminAuth }));
    assert.equal(orders.length, 1, 'still one bill');
    const order = orders[0];
    assert.equal(order.sends.length, 2);
    assert.equal(order.sends[0].tickets[0].status, 'served', 'round 1 is untouched');
    assert.equal(order.sends[1].tickets[0].status, 'sent', 'round 2 starts fresh');
    assert.equal(order.status, 'sent', 'the table rolls back up to the most urgent round');
    assert.equal(order.subtotal, Math.round((s.roti.price + s.teh.price * 2) * 100) / 100);
  });
});

test('a correction is applied to the draft the customer is looking at', async () => {
  await withDb(async () => {
    let s;
    const { base, calls } = await startApp({
      transcript: 'make the teh tarik two',
      propose: () => ({
        understood: true,
        items: [{ menu_item_id: s.teh.id, quantity: 2, modifier_option_ids: [], note: '' }],
        clarification: '',
      }),
    });
    s = await setup(base);

    const body = await json(await speak(base, s.token, {
      draft: [{ item_id: s.teh.id, name: s.teh.name, qty: 1, note: '', mods: [] }],
    }));
    assert.match(calls.lastDraftText, /1 x Teh Tarik/, 'the model is shown what to correct');
    assert.equal(body.lines[0].qty, 2);
    assert.equal(body.lines.length, 1, 'a correction replaces the draft rather than adding to it');

    // Still nothing sent.
    const orders = await json(await fetch(`${base}/api/orders`, { headers: s.adminAuth }));
    assert.equal(orders.length, 0);
  });
});

test('a clarification is passed through as one short question', async () => {
  await withDb(async () => {
    let s;
    const { base } = await startApp({
      propose: () => ({
        understood: true,
        items: [{ menu_item_id: s.teh.id, quantity: 1, modifier_option_ids: [], note: '' }],
        clarification: 'Did you mean Teh O Ais or Teh O Limau?',
      }),
    });
    s = await setup(base);
    const body = await json(await speak(base, s.token));
    assert.equal(body.clarification, 'Did you mean Teh O Ais or Teh O Limau?');
    assert.equal(body.lines.length, 1, 'a best guess is still shown alongside the question');
  });
});

test('nothing intelligible means an honest no, not an empty order', async () => {
  await withDb(async () => {
    const { base } = await startApp({
      transcript: 'aaaah',
      propose: () => ({ understood: false, items: [], clarification: '' }),
    });
    const s = await setup(base);
    const body = await json(await speak(base, s.token));
    assert.equal(body.understood, false);
    assert.equal(body.lines.length, 0);
    assert.equal(body.subtotal, 0);
  });
});

test('the endpoint refuses bad audio, oversized audio and an unknown table', async () => {
  await withDb(async () => {
    const { base, calls } = await startApp();
    const s = await setup(base);

    const wrongType = await speak(base, s.token, { mime_type: 'application/pdf' });
    assert.equal(wrongType.status, 400);
    assert.equal((await json(wrongType)).message, 'That recording did not come through. Please try again.');

    const tooBig = await speak(base, s.token, { audio_base64: Buffer.alloc(800 * 1024, 3).toString('base64') });
    assert.equal(tooBig.status, 400);
    assert.equal((await json(tooBig)).error, 'too_long');

    const unknownTable = await speak(base, 'not-a-real-token');
    assert.equal(unknownTable.status, 400);
    assert.equal(calls.transcribe, 0, 'an unknown table never reaches the speech vendor');
  });
});

test('a vendor failure is a friendly sentence, never an API error body', async () => {
  await withDb(async () => {
    const { base, voice } = await startApp();
    const s = await setup(base);
    voice.setProviders({
      transcribe: async () => { throw Object.assign(new Error('boom'), { detail: 'sk-secret-key leaked in body' }); },
    });

    const r = await speak(base, s.token);
    assert.equal(r.status, 502);
    const body = await json(r);
    assert.equal(body.message, 'Sorry, we could not hear that clearly. Please try again.');
    assert.equal(JSON.stringify(body).includes('sk-secret'), false, 'no vendor detail reaches the customer');
    assert.equal(JSON.stringify(body).includes('boom'), false);
  });
});

test('the menu the model sees is the menu and nothing else', async () => {
  await withDb(async () => {
    let s;
    const { base, calls } = await startApp({
      propose: () => ({ understood: false, items: [], clarification: '' }),
    });
    s = await setup(base);

    // Give it something to leak: an order, a staff member, and a takings figure
    // all exist by this point in a real service.
    await confirm(base, s.token, [{ item_id: s.roti.id, qty: 1 }]);
    await speak(base, s.token);

    const seen = calls.lastMenuText;
    assert.match(seen, /MENU ITEMS/);
    assert.match(seen, new RegExp(s.roti.name));
    assert.equal(/qr_token|pin_hash|Admin|order_sends|table_id/.test(seen), false,
      'no identity, no orders, no staff, no takings');
    assert.equal(/RM|price_cents/.test(seen), false,
      'not even prices: the model has no business knowing what things cost');
  });
});

test('voice switched off is a 503 with a sentence a diner can read', async () => {
  await withDb(async () => {
    const port = await getFreePort();
    process.env.PORT = String(port);
    process.env.ADMIN_PIN = '1234';
    process.env.VOICE_ORDERING = '0';
    clearSrcCache();
    require(SERVER_MODULE);
    const base = `http://localhost:${port}`;
    await waitReady(base);
    const s = await setup(base);

    const info = await json(await fetch(`${base}/api/t/${s.token}`));
    assert.equal(info.voice.enabled, false, 'the page is told not to show a microphone');

    const r = await speak(base, s.token);
    assert.equal(r.status, 503);
    assert.equal((await json(r)).message, 'Voice ordering is not switched on here. Please browse the menu instead.');
    process.env.VOICE_ORDERING = '1';
  });
});
