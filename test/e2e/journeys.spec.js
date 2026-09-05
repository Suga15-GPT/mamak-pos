const { test, expect } = require('@playwright/test');

// The journeys named by docs/prompts/_CONVENTIONS.md, plus the add-on
// regression the master redesign exists for. All run through the real UI.

// Sessions are an httpOnly cookie; Playwright's `request` fixture keeps its own
// cookie jar across calls made through it, so logging in once is enough — only
// the CSRF token needs threading through by hand for mutating calls.
async function apiLogin(request) {
  const r = await request.post('/api/login', { data: { name: 'Admin', pin: '1234' } });
  return (await r.json()).csrf_token;
}

async function login(page) {
  await page.goto('/');
  await page.locator('#lname').fill('Admin');
  await page.locator('#lpin').fill('1234');
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page.locator('#app-view')).toBeVisible();
  const collapsed = await openAccountMenu(page);
  await expect(page.locator('#uname')).toHaveText(/Admin/);
  if (collapsed) await page.locator('#account-toggle').click(); // put it away again
}

// The nav renders twice (a left rail from 768px up, a bottom bar below it); at
// the desktop viewport the rail is the visible copy.
const navTab = (page, name) => page.locator('#nav').getByRole('button', { name });

/* The header's account controls live behind one disclosure button at every
   width, so a check has to open them before it can see the user's name. */
async function openAccountMenu(page) {
  const toggle = page.locator('#account-toggle');
  if (!(await toggle.isVisible())) return false;
  await toggle.click();
  return true;
}

async function openTable(page, name) {
  await page.locator('#tables-grid').getByRole('button', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(page.locator('#ws-title')).toHaveText(name);
}

// Tapping an item adds it straight to the bill — the redesign removed the
// remark dialog that used to stand between the waiter and every single item.
// Scoped to the whole workspace, not just #menu-items: a top seller is lifted
// out of its category grid into the "Popular today" row above it.
async function addItem(page, category, item) {
  await page.locator('#menu-cats').getByRole('button', { name: category, exact: true }).click();
  await page.locator('#pos-workspace').getByRole('button', { name: new RegExp(item) }).first().click();
}

test('staff login → order → kitchen → pay', async ({ page, request }) => {
  // A payment is refused unless a shift is open.
  const csrfToken = await apiLogin(request);
  await request.post('/api/shift/open', { headers: { 'X-CSRF-Token': csrfToken }, data: { float: 0 } });

  await login(page);
  await openTable(page, 'T1');
  await addItem(page, 'Roti', 'Roti Canai');
  await expect(page.locator('#cart-body')).toContainText('Roti Canai');

  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Already sent');
  await expect(page.locator('#cart-body')).toContainText('Round 1');

  await navTab(page, 'Kitchen').click();
  await expect(page.locator('#k-col-sent')).toContainText('T1');
  await expect(page.locator('#k-col-sent')).toContainText('Roti Canai');

  await page.locator('#k-col-sent').getByRole('button', { name: /Start cooking/ }).click();
  await expect(page.locator('#k-col-preparing')).toContainText('T1');
  await page.locator('#k-col-preparing').getByRole('button', { name: /Ready/ }).click();
  await expect(page.locator('#k-col-ready')).toContainText('T1');
  await page.locator('#k-col-ready').getByRole('button', { name: /Served/ }).click();
  await expect(page.locator('#k-col-served')).toContainText('T1');

  // Returning to the floor tab comes back to the bill that was open, refreshed.
  await navTab(page, 'Tables').click();
  await expect(page.locator('#ws-title')).toHaveText('T1');
  await page.getByRole('button', { name: /^💵 Take Payment$/ }).click();
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
  await page.locator('#pay-modal').getByRole('button', { name: '💵 Cash', exact: true }).click();
  // Settling returns to the floor.
  await expect(page.locator('#pos-tables')).toBeVisible();
});

/* The regression the whole redesign exists for (master spec §53). */
test('add-on opens a new round: round 1 stays served, round 2 is new', async ({ page, request }) => {
  const csrfToken = await apiLogin(request);
  const existing = await request.get('/api/shift/current').then(r => r.json());
  if (!existing) await request.post('/api/shift/open', { headers: { 'X-CSRF-Token': csrfToken }, data: { float: 0 } });

  await login(page);
  await openTable(page, 'T8');
  await addItem(page, 'Mee & Goreng', 'Mee Goreng Mamak');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Round 1');

  // Take round 1 all the way through the kitchen.
  await navTab(page, 'Kitchen').click();
  const r1 = page.locator('.k-order', { hasText: 'T8' });
  await r1.getByRole('button', { name: /Start cooking/ }).click();
  await page.locator('#k-col-preparing').locator('.k-order', { hasText: 'T8' }).getByRole('button', { name: /Ready/ }).click();
  await page.locator('#k-col-ready').locator('.k-order', { hasText: 'T8' }).getByRole('button', { name: /Served/ }).click();
  await expect(page.locator('#k-col-served')).toContainText('T8');

  // Later, the same table orders one more thing.
  await navTab(page, 'Tables').click();
  await expect(page.locator('#ws-title')).toHaveText('T8');
  await addItem(page, 'Roti', 'Roti Canai');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();

  // Same bill, two rounds, and the add-on is NOT served.
  await expect(page.locator('#cart-body')).toContainText('Round 1');
  await expect(page.locator('#cart-body')).toContainText('Round 2');
  await expect(page.locator('#cart-body')).toContainText('Mee Goreng Mamak');
  await expect(page.locator('#cart-body')).toContainText('Roti Canai');

  const round2 = page.locator('.bill-round-head', { hasText: 'Round 2' });
  await expect(round2).toContainText('New order');
  const round1 = page.locator('.bill-round-head', { hasText: 'Round 1' });
  await expect(round1).toContainText('Served');

  // The kitchen sees the add-on as its own fresh ticket.
  await navTab(page, 'Kitchen').click();
  await expect(page.locator('#k-col-sent')).toContainText('T8');
  await expect(page.locator('#k-col-sent')).toContainText('Add-on · Round 2');
  await expect(page.locator('#k-col-sent')).toContainText('Roti Canai');
  await expect(page.locator('#k-col-sent')).not.toContainText('Mee Goreng Mamak');
});

test('QR customer orders, then orders more on the same bill', async ({ page, request }) => {
  await apiLogin(request);
  const tables = await request.get('/api/admin/tables').then(r => r.json());
  const t2 = tables.find(t => t.name === 'T2');

  await page.goto(t2.url);
  await expect(page.locator('#table-name')).toHaveText('T2');

  await page.locator('#menu-cats').getByRole('button', { name: 'Roti', exact: true }).click();
  await page.locator('#menu-items').getByRole('button', { name: /Roti Telur/ }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(page.locator('#bar-count')).toHaveText('1');
  await page.getByRole('button', { name: 'View Order' }).click();
  await expect(page.locator('#cart-lines')).toContainText('Roti Telur');
  await page.getByRole('button', { name: 'Place Order' }).click();

  await expect(page.getByRole('heading', { name: 'Order sent' })).toBeVisible();
  await expect(page.locator('#success-steps')).toContainText('Sent');

  // Ordering more is the whole point: a second scan used to be refused.
  await page.locator('#success-view').getByRole('button', { name: 'Browse the menu' }).click();
  await expect(page.locator('#my-orders')).toContainText('Roti Telur');
  await page.locator('#menu-cats').getByRole('button', { name: 'Minuman Panas', exact: true }).click();
  await page.locator('#menu-items').getByRole('button', { name: /Teh Tarik/ }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'View Order' }).click();
  await page.getByRole('button', { name: 'Place Order' }).click();
  await expect(page.getByRole('heading', { name: 'Order sent' })).toBeVisible();

  // One bill, two rounds, both items on it.
  const orders = await request.get('/api/orders').then(r => r.json());
  const t2Order = orders.find(o => o.table === 'T2');
  expect(t2Order.sends.length).toBe(2);
  expect(t2Order.items.map(i => i.name).sort()).toEqual(['Roti Telur', 'Teh Tarik']);
});

test('takeaway order needs no table', async ({ page, request }) => {
  const csrfToken = await apiLogin(request);
  const existing = await request.get('/api/shift/current').then(r => r.json());
  if (!existing) await request.post('/api/shift/open', { headers: { 'X-CSRF-Token': csrfToken }, data: { float: 0 } });

  await login(page);
  await page.getByRole('button', { name: /New Takeaway/ }).click();
  await expect(page.locator('#ws-title')).toHaveText('New takeaway');
  await addItem(page, 'Roti', 'Roti Canai');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#ws-title')).toContainText('Takeaway #');

  await page.getByRole('button', { name: /Back to Tables/ }).click();
  await expect(page.locator('#takeaway-grid')).toContainText('Takeaway #');
});

test('split bill', async ({ page, request }) => {
  const csrfToken = await apiLogin(request);
  const existingShift = await request.get('/api/shift/current').then(r => r.json());
  if (!existingShift) await request.post('/api/shift/open', { headers: { 'X-CSRF-Token': csrfToken }, data: { float: 0 } });

  // The order stays 'sent' throughout, so "Pay" fires the "food still cooking?"
  // confirm() — accept it.
  page.on('dialog', dialog => dialog.accept());

  await login(page);
  await openTable(page, 'T3');
  await addItem(page, 'Roti', 'Roti Canai');
  await addItem(page, 'Roti', 'Roti Canai');
  await expect(page.locator('#cart-body')).toContainText('2×');

  await page.getByRole('button', { name: /Send 2 new items/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Already sent');

  await page.getByRole('button', { name: /^💵 Take Payment$/ }).click();
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
  await page.getByRole('button', { name: 'Split evenly' }).click();
  // The styled ask() dialog replaced window.prompt() — it is part of the page.
  await expect(page.getByRole('heading', { name: 'Split evenly' })).toBeVisible();
  await page.locator('#ask-input').fill('2');
  await page.getByRole('button', { name: 'Split', exact: true }).click();

  await expect(page.locator('#pay-split-result')).toContainText('Share 1');
  await expect(page.locator('#pay-split-result')).toContainText('Share 2');

  await page.getByRole('button', { name: 'Pay cash' }).first().click();
  await expect(page.locator('#pay-split-result')).not.toContainText('Share 1');
  await page.getByRole('button', { name: 'Pay cash' }).first().click();
  await expect(page.locator('#pos-tables')).toBeVisible();
});

test('void a line', async ({ page }) => {
  await login(page);

  // Two lines, not one — voiding the only line on an unpaid order drops its
  // total to zero, which equals what's already paid (nothing) and auto-settles
  // it. A second line keeps the order open through the void.
  await openTable(page, 'T4');
  await addItem(page, 'Roti', 'Roti Canai');
  await addItem(page, 'Roti', 'Roti Telur');
  await page.getByRole('button', { name: /Send 2 new items/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Already sent');

  const canaiLine = page.locator('.bill-line', { hasText: 'Roti Canai' });
  await canaiLine.getByRole('button', { name: /Void/ }).click();
  await expect(page.getByRole('heading', { name: /Void Roti Canai/ })).toBeVisible();
  await page.locator('#ask-input').fill('customer changed their mind');
  await page.getByRole('button', { name: 'Void it' }).click();

  await expect(page.locator('.bill-line', { hasText: 'Roti Canai' })).toContainText('Voided');
  await expect(page.locator('.bill-line', { hasText: 'Roti Telur' })).not.toContainText('Voided');
});

test('offline order reconciles', async ({ page, context, request }) => {
  await login(page);
  await context.setOffline(true);

  await openTable(page, 'T6');
  await addItem(page, 'Roti', 'Roti Canai');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Sending');
  await expect(page.locator('#offline-banner')).toBeVisible();
  await expect(page.locator('#offline-banner')).toContainText('1 order');

  await page.getByRole('button', { name: /Back to Tables/ }).click();
  await openTable(page, 'T7');
  await addItem(page, 'Roti', 'Roti Telur');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#offline-banner')).toContainText('2 orders');

  await context.setOffline(false);
  await expect(page.locator('#offline-banner')).toBeHidden();
  await expect(page.locator('#cart-body')).toContainText('Already sent');

  await apiLogin(request);
  const orders = await request.get('/api/orders').then(r => r.json());
  const t6 = orders.find(o => o.table === 'T6');
  const t7 = orders.find(o => o.table === 'T7');
  expect(t6).toBeTruthy();
  expect(t7).toBeTruthy();
  expect(t6.items.some(i => i.name === 'Roti Canai')).toBe(true);
  expect(t7.items.some(i => i.name === 'Roti Telur')).toBe(true);
});

test('shift open → close', async ({ page, request }) => {
  // Close whatever shift an earlier journey left open, so this one exercises a
  // clean open → close cycle of its own end to end through the UI.
  const csrfToken = await apiLogin(request);
  const csrfHeaders = { 'X-CSRF-Token': csrfToken };
  const existingShift = await request.get('/api/shift/current').then(r => r.json());
  if (existingShift) {
    const rep = await request.get(`/api/shift/${existingShift.id}/report`).then(r => r.json());
    await request.post('/api/shift/close', { headers: csrfHeaders, data: { counted: rep.cash.expected_cents / 100 } });
  }

  await login(page);
  await navTab(page, 'Shift').click();
  await expect(page.locator('#shift-closed-card')).toBeVisible();

  await page.locator('#shift-float-input').fill('200');
  await page.getByRole('button', { name: 'Open Shift' }).click();
  await expect(page.locator('#shift-open-card')).toBeVisible();
  await expect(page.locator('#shift-status')).toContainText('RM 200.00');

  await page.getByRole('button', { name: 'Close Shift' }).click();
  await expect(page.locator('#shift-close-form')).toBeVisible();
  // 4 x RM50 = RM 200.00, matching the float with no sales in between.
  await page.locator('[data-cents="5000"]').fill('4');
  await expect(page.locator('#denom-total')).toHaveText('RM 200.00');

  await page.getByRole('button', { name: 'Confirm Close' }).click();
  await expect(page.locator('#shift-report-card')).toBeVisible();
  await expect(page.locator('#shift-variance-badge')).toContainText('RM 0.00');
});

/* Speak to Order, end to end, with the vendors replaced by a local word matcher
   (VOICE_MODE=mock in playwright.config.js) and a synthetic microphone. The
   point of the journey is the ordering of events: a preview exists, nothing is
   in the kitchen, and only the customer's confirmation changes that. */
test('QR customer speaks an order, reviews it, and only then does the kitchen get it', async ({ page, request }) => {
  await apiLogin(request);
  const tables = await request.get('/api/admin/tables').then(r => r.json());
  const t5 = tables.find(t => t.name === 'T5');

  await page.goto(t5.url);
  await expect(page.locator('#voice-hero')).toBeVisible();

  await page.getByRole('button', { name: 'Speak your order' }).click();
  await expect(page.locator('#vs-listening')).toBeVisible();
  // Long enough for the fake device to produce more than the "that was a tap"
  // floor the page applies.
  await page.waitForTimeout(1800);
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  await expect(page.getByRole('heading', { name: /Here.s what I got/ })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#vs-lines')).toContainText('Roti Canai');
  await expect(page.locator('#vs-lines')).toContainText('Teh Tarik');
  // Two roti: the matcher read "dua" the way a Malaysian customer says it.
  await expect(page.locator('#vs-lines')).toContainText('2×');

  // Prices on the preview are the restaurant's, and the total is their sum.
  const menu = await request.get('/api/menu').then(r => r.json());
  const roti = menu.items.find(i => i.name === 'Roti Canai');
  const teh = menu.items.find(i => i.name === 'Teh Tarik');
  const expected = `RM ${(roti.price * 2 + teh.price).toFixed(2)}`;
  await expect(page.locator('#vs-total')).toHaveText(expected);

  // Nothing has been created yet — this is the property the whole design exists
  // for. (Scoped to this table: the suite shares one database.)
  const before = await request.get('/api/orders').then(r => r.json());
  expect(before.find(o => o.table === 'T5')).toBeUndefined();

  // The customer edits, then confirms.
  await page.locator('#vs-lines .qty button').first().click();   // one fewer roti
  await expect(page.locator('#vs-total')).toHaveText(`RM ${(roti.price + teh.price).toFixed(2)}`);
  await page.getByRole('button', { name: 'Confirm order' }).click();

  await expect(page.getByRole('heading', { name: 'Order sent' })).toBeVisible({ timeout: 15000 });

  const orders = await request.get('/api/orders').then(r => r.json());
  const order = orders.find(o => o.table === 'T5');
  expect(order.source).toBe('qr');
  expect(order.sends.length).toBe(1);
  expect(order.items.map(i => i.name).sort()).toEqual(['Roti Canai', 'Teh Tarik']);
  expect(order.subtotal).toBeCloseTo(roti.price + teh.price, 2);
});

test('a spoken order the customer abandons leaves nothing behind', async ({ page, request }) => {
  await apiLogin(request);
  const tables = await request.get('/api/admin/tables').then(r => r.json());
  const t6 = tables.find(t => t.name === 'T6');

  // The suite shares one database and earlier journeys have left orders on the
  // floor, so the assertion is "nothing changed", not "nothing exists".
  const before = await request.get('/api/orders').then(r => r.json());

  await page.goto(t6.url);
  await page.getByRole('button', { name: 'Speak your order' }).click();
  await page.waitForTimeout(1800);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Here.s what I got/ })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#vs-lines')).toContainText('Roti Canai');

  await page.locator('#vs-review').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#voice-modal')).not.toHaveClass(/show/);

  const after = await request.get('/api/orders').then(r => r.json());
  expect(after).toEqual(before);
});

/* Help has to be usable by the person who needs it, which means findable by a
   word they would actually type. */
test('help centre: search, open a topic, step its walkthrough', async ({ page }) => {
  await login(page);
  await navTab(page, 'Help').click();
  await expect(page.locator('.help-card').first()).toBeVisible();

  await page.locator('#help-search').fill('sold out');
  await expect(page.locator('.help-card')).toHaveCount(1);
  await page.locator('.help-card').click();
  await expect(page.getByRole('heading', { name: /Sold out/ })).toBeVisible();

  // The walkthrough is real: stepping it changes the caption and the frame.
  const caption = page.locator('#wt-caption');
  await expect(caption).toContainText('1.');
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(caption).toContainText('2.');
  await expect(page.locator('#wt-stage .wt-cell.hit')).toBeVisible();

  await page.getByRole('button', { name: 'All help' }).click();
  await expect(page.locator('#help-search')).toBeVisible();

  // A contextual "?" link elsewhere in the app lands on the right topic.
  await navTab(page, 'Kitchen').click();
  await page.getByRole('button', { name: /How Kitchen works/ }).click();
  await expect(page.getByRole('heading', { name: /The kitchen screen/ })).toBeVisible();
});

/* Master spec §39 / §60: the mobile "shrink" complaint is horizontal overflow.
   Check the real thing — the document is never wider than the viewport. */
const VIEWPORTS = [
  { name: 'iPhone 12', width: 390, height: 844 },
  { name: 'iPhone 14 Pro Max', width: 430, height: 932 },
  { name: 'iPad portrait', width: 768, height: 1024 },
  { name: 'iPad landscape', width: 1024, height: 768 },
  { name: 'laptop', width: 1366, height: 768 },
];

for (const vp of VIEWPORTS) {
  test(`no horizontal overflow at ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page);

    const overflowOn = async label => {
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `${label} overflows at ${vp.name}`).toBeLessThanOrEqual(clientWidth + 1);
    };

    await overflowOn('floor');

    // Every destination this role can reach, including the Admin sections that
    // were the worst offenders (printers, the QR grid, modifier controls).
    const tabs = vp.width < 768 ? page.locator('#bottom-nav button') : page.locator('#nav button');
    const count = await tabs.count();
    for (let i = 0; i < count; i++) {
      await tabs.nth(i).click();
      await page.waitForTimeout(150);
      await overflowOn(`tab ${i}`);
    }

    // The loop above ends on whichever tab is last (Help); come back to Admin
    // before walking its sections.
    await tabs.filter({ hasText: 'Admin' }).click();
    await page.locator('#admin-tabs').scrollIntoViewIfNeeded();
    const sections = page.locator('#admin-tabs button');
    for (let i = 0; i < await sections.count(); i++) {
      await sections.nth(i).click();
      await page.waitForTimeout(200);
      await overflowOn(`admin section ${i}`);
    }
  });
}
