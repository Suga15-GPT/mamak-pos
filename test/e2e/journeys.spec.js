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

// Card mode: the floor is a grid of numbered cards. Tapping a free card starts
// its order; tapping an in-use card opens its bill.
async function openCard(page, number) {
  await page.locator('#tables-grid').getByRole('button', { name: new RegExp(`^Card ${number}\\b`) }).click();
  await expect(page.locator('#ws-title')).toHaveText(`Card ${number}`);
}

// Tapping an item adds it straight to the bill — the redesign removed the
// remark dialog that used to stand between the waiter and every single item.
// Scoped to the whole workspace, not just #menu-items: a top seller is lifted
// out of its category grid into the "Popular today" row above it.
async function addItem(page, category, item) {
  await page.locator('#menu-cats').getByRole('button', { name: category, exact: true }).click();
  await page.locator('#pos-workspace').getByRole('button', { name: new RegExp(item) }).first().click();
}

const MODULES = ['kitchen', 'stations', 'printing', 'shifts', 'discounts', 'refunds', 'split_combine', 'qr', 'voice', 'dashboard'];
const LITE_JOURNEY = 'first run: the setup wizard with Small stall, then order and pay with no shift and no kitchen';

/* Every journey except the first-run one runs as a full restaurant (Advanced),
   exactly as before feature modules existed. The first-run journey leaves the
   shop on Lite with 20 cards, so this puts everything back each time. */
test.beforeEach(async ({ request }, testInfo) => {
  if (testInfo.title === LITE_JOURNEY) return;
  const csrfToken = await apiLogin(request);
  const r = await request.post('/api/setup', {
    headers: { 'X-CSRF-Token': csrfToken },
    data: { features: Object.fromEntries(MODULES.map(m => [m, true])), card_count: 50 },
  });
  expect(r.status()).toBe(200);
});

/* Runs first: the database is fresh, so the admin is sent straight into the
   wizard at login and can't get past it without finishing. */
test(LITE_JOURNEY, async ({ page, request }) => {
  // Not login(): that opens the account menu, which the wizard sits on top of.
  await page.goto('/');
  await page.locator('#lname').fill('Admin');
  await page.locator('#lpin').fill('1234');
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page.locator('#app-view')).toBeVisible();
  const wizard = page.locator('#setup-modal');
  await page.waitForLoadState('networkidle');
  if (!(await wizard.isVisible())) {
    // Run on its own after another journey finished setup: reopen it from Admin.
    await navTab(page, 'Admin').click();
    await page.locator('#admin-tabs').getByRole('button', { name: /Features & setup/ }).click();
    await page.getByRole('button', { name: 'Run setup again' }).click();
  }
  await expect(wizard).toBeVisible();
  await expect(wizard.locator('#setup-cancel')).toBeHidden();

  // 1. Shop details — the name is required.
  await expect(page.locator('#setup-step')).toHaveText('Step 1 of 6');
  await page.locator('#setup-name').fill('');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#setup-err')).toContainText('shop name');
  await page.locator('#setup-name').fill('Gerai Pak Ali');
  await page.locator('#setup-tax').fill('6');
  await page.locator('#setup-svc').fill('0');
  await wizard.getByRole('button', { name: 'Next' }).click();

  // 2. A starting point.
  await wizard.getByText('Small stall').click();
  await wizard.getByRole('button', { name: 'Next' }).click();

  // 3. Every module, pre-ticked from the preset: all off for a small stall.
  const sw = mod => wizard.locator(`input[data-module="${mod}"]`);
  // The checkbox itself is visually hidden inside its switch; tap the switch.
  const flip = mod => wizard.locator('label.switch', { has: page.locator(`input[data-module="${mod}"]`) }).click();
  for (const m of MODULES) await expect(sw(m)).not.toBeChecked();
  await expect(sw('stations')).toBeDisabled();
  // Switching a parent off takes its child with it, and the owner is told.
  await flip('kitchen');
  await flip('stations');
  await expect(sw('stations')).toBeChecked();
  await flip('kitchen');
  await expect(wizard.locator('.feature-note')).toContainText('Separate drinks and food screens was switched off too');
  await expect(sw('stations')).not.toBeChecked();
  // Shifts on with no shift open: the owner is told payments will be refused.
  await flip('shifts');
  await expect(wizard.locator('.feature-shift-note')).toContainText('every payment will be refused until someone opens one');
  await flip('shifts');
  await expect(wizard.locator('.feature-shift-note')).toHaveCount(0);
  await wizard.getByRole('button', { name: 'Next' }).click();

  // 4. Cards. QR is off, so there is no QR step: review is step 5 of 5.
  await page.locator('#setup-cards').fill('20');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#setup-step')).toHaveText('Step 5 of 5');
  await expect(wizard).toContainText('Gerai Pak Ali');
  await expect(wizard).toContainText('20 cards');
  await wizard.getByRole('button', { name: 'Finish setup' }).click();
  await expect(wizard).toBeHidden();

  // The app is a simple order-and-pay till: no Shift, no Kitchen, no Sales.
  await expect(navTab(page, 'Cards')).toBeVisible();
  await expect(navTab(page, 'Shift')).toHaveCount(0);
  await expect(navTab(page, 'Kitchen')).toHaveCount(0);
  await expect(navTab(page, 'Sales')).toHaveCount(0);
  await expect(page.locator('#tables-grid').getByRole('button', { name: /^Card 20\b/ })).toBeVisible();
  await expect(page.locator('#tables-grid').getByRole('button', { name: /^Card 21\b/ })).toHaveCount(0);

  await openCard(page, 1);
  await addItem(page, 'Roti', 'Roti Canai');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Already sent');

  await page.getByRole('button', { name: /^💵 Take Payment$/ }).click();
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
  await expect(page.locator('#pay-discount-section')).toBeHidden();
  await expect(page.locator('#pay-split-section')).toBeHidden();
  await page.locator('#pay-modal').getByRole('button', { name: '💵 Cash', exact: true }).click();
  await expect(page.locator('#pos-tables')).toBeVisible();

  // Paid with no shift open and without ever going through a kitchen.
  await apiLogin(request);
  expect((await request.get('/api/shift/current')).status()).toBe(404);
  const recent = await request.get('/api/orders?mode=recent').then(r => r.json());
  const order = recent.find(o => o.label === 'Card 1');
  expect(order.status).toBe('paid');
  expect(order.payments).toHaveLength(1);
  expect(order.sends[0].tickets.every(tk => tk.status === 'served')).toBe(true);
  const features = await request.get('/api/features').then(r => r.json());
  expect(features.setup_completed).toBe(true);
  expect(Object.values(features.features).every(v => v === false)).toBe(true);

  // Sales figures are the dashboard's: switched off, they aren't served.
  expect((await request.get('/api/summary')).status()).toBe(404);
});

test('staff login → order → kitchen → pay', async ({ page, request }) => {
  // A payment is refused unless a shift is open.
  const csrfToken = await apiLogin(request);
  await request.post('/api/shift/open', { headers: { 'X-CSRF-Token': csrfToken }, data: { float: 0 } });

  await login(page);
  await openCard(page, 1);
  await addItem(page, 'Roti', 'Roti Canai');
  await expect(page.locator('#cart-body')).toContainText('Roti Canai');

  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Already sent');
  await expect(page.locator('#cart-body')).toContainText('Round 1');

  await navTab(page, 'Kitchen').click();
  await expect(page.locator('#k-col-sent')).toContainText('Card 1');
  await expect(page.locator('#k-col-sent')).toContainText('Roti Canai');

  await page.locator('#k-col-sent').getByRole('button', { name: /Start cooking/ }).click();
  await expect(page.locator('#k-col-preparing')).toContainText('Card 1');
  await page.locator('#k-col-preparing').getByRole('button', { name: /Ready/ }).click();
  await expect(page.locator('#k-col-ready')).toContainText('Card 1');
  await page.locator('#k-col-ready').getByRole('button', { name: /Served/ }).click();
  await expect(page.locator('#k-col-served')).toContainText('Card 1');

  // Returning to the floor tab comes back to the bill that was open, refreshed.
  await navTab(page, 'Cards').click();
  await expect(page.locator('#ws-title')).toHaveText('Card 1');
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
  await openCard(page, 8);
  await addItem(page, 'Mee & Goreng', 'Mee Goreng Mamak');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Round 1');

  // Take round 1 all the way through the kitchen.
  await navTab(page, 'Kitchen').click();
  const r1 = page.locator('.k-order', { hasText: 'Card 8' });
  await r1.getByRole('button', { name: /Start cooking/ }).click();
  await page.locator('#k-col-preparing').locator('.k-order', { hasText: 'Card 8' }).getByRole('button', { name: /Ready/ }).click();
  await page.locator('#k-col-ready').locator('.k-order', { hasText: 'Card 8' }).getByRole('button', { name: /Served/ }).click();
  await expect(page.locator('#k-col-served')).toContainText('Card 8');

  // Later, the same card orders one more thing.
  await navTab(page, 'Cards').click();
  await expect(page.locator('#ws-title')).toHaveText('Card 8');
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
  await expect(page.locator('#k-col-sent')).toContainText('Card 8');
  await expect(page.locator('#k-col-sent')).toContainText('Add-on · Round 2');
  await expect(page.locator('#k-col-sent')).toContainText('Roti Canai');
  await expect(page.locator('#k-col-sent')).not.toContainText('Mee Goreng Mamak');
});

test('QR customer orders, then orders more on the same bill', async ({ page, request }) => {
  await apiLogin(request);
  const cards = await request.get('/api/admin/cards').then(r => r.json());
  const c2 = cards.find(c => c.number === 2);

  await page.goto(c2.url);
  await expect(page.locator('#table-name')).toHaveText('Card 2');

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
  const c2Order = orders.find(o => o.label === 'Card 2');
  expect(c2Order.sends.length).toBe(2);
  expect(c2Order.items.map(i => i.name).sort()).toEqual(['Roti Telur', 'Teh Tarik']);
});

test('takeaway order needs no card', async ({ page, request }) => {
  const csrfToken = await apiLogin(request);
  const existing = await request.get('/api/shift/current').then(r => r.json());
  if (!existing) await request.post('/api/shift/open', { headers: { 'X-CSRF-Token': csrfToken }, data: { float: 0 } });

  await login(page);
  await page.getByRole('button', { name: /New Takeaway/ }).click();
  await expect(page.locator('#ws-title')).toHaveText('New takeaway');
  await addItem(page, 'Roti', 'Roti Canai');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#ws-title')).toContainText('Takeaway #');

  await page.getByRole('button', { name: /Back to Cards/ }).click();
  await expect(page.locator('#takeaway-grid')).toContainText('Takeaway #');
});

/* Paying before the food is made is normal: a takeaway paid at the counter.
   The kitchen screen keeps it until it is served, and serving it leaves the
   paid bill exactly as it was paid. */
test('a takeaway paid at the counter stays on the kitchen screen until it is served', async ({ page, request }) => {
  const csrfToken = await apiLogin(request);
  const existing = await request.get('/api/shift/current').then(r => r.json());
  if (!existing) await request.post('/api/shift/open', { headers: { 'X-CSRF-Token': csrfToken }, data: { float: 0 } });
  // Nothing is cooked yet, so Take Payment asks "Take payment anyway?".
  page.on('dialog', dialog => dialog.accept());

  await login(page);
  await page.getByRole('button', { name: /New Takeaway/ }).click();
  await addItem(page, 'Roti', 'Roti Telur');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#ws-title')).toContainText('Takeaway #');
  const label = (await page.locator('#ws-title').textContent()).trim();
  const orderId = Number(label.replace('Takeaway #', ''));

  await page.getByRole('button', { name: /^💵 Take Payment$/ }).click();
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
  await page.locator('#pay-modal').getByRole('button', { name: '💵 Cash', exact: true }).click();
  await expect(page.locator('#pos-tables')).toBeVisible();
  const paid = (await request.get('/api/orders?mode=recent').then(r => r.json())).find(o => o.id === orderId);
  expect(paid.status).toBe('paid');

  await navTab(page, 'Kitchen').click();
  const ticket = column => page.locator(`#k-col-${column} .k-order`, { hasText: new RegExp(`${label}\\b`) });
  await expect(ticket('sent')).toContainText('Roti Telur');
  await ticket('sent').getByRole('button', { name: /Start cooking/ }).click();
  await ticket('preparing').getByRole('button', { name: /Ready/ }).click();
  await ticket('ready').getByRole('button', { name: /Served/ }).click();
  await expect(ticket('served')).toBeVisible();

  const after = (await request.get('/api/orders?mode=recent').then(r => r.json())).find(o => o.id === orderId);
  expect(after.status).toBe('paid');
  expect(after.grand_total).toBe(paid.grand_total);
  expect(after.paid_at).toBe(paid.paid_at);
  expect(after.updated_at).toBe(paid.updated_at);   // the taps never wrote to the bill
  expect(after.sends[0].tickets.map(t => t.status)).toEqual(['served']);
});

test('split bill', async ({ page, request }) => {
  const csrfToken = await apiLogin(request);
  const existingShift = await request.get('/api/shift/current').then(r => r.json());
  if (!existingShift) await request.post('/api/shift/open', { headers: { 'X-CSRF-Token': csrfToken }, data: { float: 0 } });

  // The order stays 'sent' throughout, so "Pay" fires the "food still cooking?"
  // confirm() — accept it.
  page.on('dialog', dialog => dialog.accept());

  await login(page);
  await openCard(page, 3);
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

/* Card mode, before Combine merged bills: two cards that kept their own
   orders and paid together. The till no longer makes such a group, but one
   that existed when merging shipped still shows on both cards and is paid in
   one go — here RM2 in cash and the rest by card, submitted together — and
   both cards free up. */
test('a combined bill from before Combine merged bills still shows, and is paid once', async ({ page, request }) => {
  const csrfToken = await apiLogin(request);
  const existing = await request.get('/api/shift/current').then(r => r.json());
  if (!existing) await request.post('/api/shift/open', { headers: { 'X-CSRF-Token': csrfToken }, data: { float: 0 } });
  // Nothing has been served, so Take Payment asks "food still cooking?".
  page.on('dialog', dialog => dialog.accept());

  await login(page);
  await openCard(page, 11);
  await addItem(page, 'Roti', 'Roti Canai');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Already sent');
  await page.getByRole('button', { name: /Back to Cards/ }).click();

  await openCard(page, 12);
  await addItem(page, 'Minuman Panas', 'Teh Tarik');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Already sent');

  // The group, made the way it was before this release (the API still can).
  const before = await request.get('/api/orders').then(r => r.json());
  const ids = ['Card 11', 'Card 12'].map(label => before.find(o => o.label === label).id);
  const made = await request.post('/api/bill-groups', { headers: { 'X-CSRF-Token': csrfToken }, data: { order_ids: ids } });
  expect(made.status()).toBe(201);
  await page.getByRole('button', { name: /Back to Cards/ }).click();
  await expect(page.locator('#tables-grid').getByRole('button', { name: /^Card 12\b/ })).toContainText('Combined bill');
  await openCard(page, 12);
  await expect(page.locator('#bill-group')).toContainText('Card 11');
  await expect(page.locator('#bill-group')).toContainText('Card 12');
  // A card on one of these is paid with it; Combine isn't offered from it.
  await expect(page.locator('#combine-btn')).toBeHidden();

  await page.getByRole('button', { name: /^💵 Take Payment$/ }).click();
  await expect(page.locator('#pay-details')).toContainText('Combined bill');
  await expect(page.locator('#pay-details')).toContainText('Roti Canai');
  await expect(page.locator('#pay-details')).toContainText('Teh Tarik');
  // Roti 2.12 + teh tarik 2.97 = 5.09: RM2.00 cash, RM3.09 by card.
  await expect(page.locator('#pay-amount-row')).toBeHidden();
  await page.locator('#group-cash-part').fill('2');
  await page.locator('#group-cash-received').fill('5');
  await expect(page.locator('#group-legs-summary')).toContainText('Cash RM 2.00 + card RM 3.09 · change RM 3.00');
  await page.getByRole('button', { name: 'Take both payments' }).click();
  await expect(page.locator('#pos-tables')).toBeVisible();

  // Both cards are free again, and the payments are ordinary per-order rows,
  // lowest card first: Card 11 by card; Card 12 the rest of the card, then cash.
  const open = await request.get('/api/orders').then(r => r.json());
  expect(open.find(o => o.label === 'Card 11' || o.label === 'Card 12')).toBeUndefined();
  const recent = await request.get('/api/orders?mode=recent').then(r => r.json());
  const paid = recent.filter(o => o.label === 'Card 11' || o.label === 'Card 12');
  expect(paid.map(o => o.status)).toEqual(['paid', 'paid']);
  const byLabel = Object.fromEntries(paid.map(o => [o.label, o.payments.map(p => [p.method, p.amount])]));
  expect(byLabel['Card 11']).toEqual([['Card', 2.12]]);
  expect(byLabel['Card 12']).toEqual([['Card', 0.97], ['Cash', 2]]);
  await expect(page.locator('#tables-grid').getByRole('button', { name: /^Card 11\b/ })).toContainText('Free');
});

/* ===== day-one fixes ===== */

const withCsrf = csrfToken => ({ headers: { 'X-CSRF-Token': csrfToken } });

async function ensureShift(request, csrfToken) {
  const existing = await request.get('/api/shift/current').then(r => r.json());
  if (!existing) await request.post('/api/shift/open', { ...withCsrf(csrfToken), data: { float: 0 } });
}

// Pays whatever bill is open on a card, so a journey can start it fresh
// whatever ran before it (the suite shares one database).
async function payOpenBill(request, csrfToken, order) {
  if (order.bill_group_id) {
    const g = await request.get(`/api/bill-groups/${order.bill_group_id}`).then(r => r.json());
    if (g.closed_at) return;
    const r = await request.post(`/api/bill-groups/${g.id}/pay`, { ...withCsrf(csrfToken), data: { legs: [{ method: 'Card', amount: g.amount_due }] } });
    expect(r.status(), `paying combined bill ${g.id}`).toBe(200);
    return;
  }
  const r = await request.post(`/api/orders/${order.id}/pay`, { ...withCsrf(csrfToken), data: { method: 'Card' } });
  expect(r.status(), `paying ${order.label}`).toBe(200);
}

async function freeCard(request, csrfToken, number) {
  const o = (await request.get('/api/orders').then(r => r.json())).find(x => x.card_number === number);
  if (!o) return;
  await ensureShift(request, csrfToken);
  await payOpenBill(request, csrfToken, o);
}

// Every bill paid, every kitchen ticket served, the shift closed: the state
// Clear sales data needs.
async function settleShop(request, csrfToken) {
  await ensureShift(request, csrfToken);
  for (const o of await request.get('/api/orders').then(r => r.json())) {
    const still = (await request.get('/api/orders').then(r => r.json())).find(x => x.id === o.id);
    if (still) await payOpenBill(request, csrfToken, still);
  }
  const next = { sent: ['preparing', 'ready', 'served'], preparing: ['ready', 'served'], ready: ['served'] };
  for (const station of ['kitchen', 'drinks']) {
    const { tickets } = await request.get(`/api/kitchen/tickets?station=${station}`).then(r => r.json());
    for (const t of tickets.filter(x => x.status !== 'served')) {
      for (const st of next[t.status]) {
        const r = await request.patch(`/api/kitchen/tickets/${t.id}`, { ...withCsrf(csrfToken), data: { status: st } });
        expect(r.status()).toBe(200);
      }
    }
  }
  const shift = await request.get('/api/shift/current').then(r => r.json());
  const rep = await request.get(`/api/shift/${shift.id}/report`).then(r => r.json());
  const closed = await request.post('/api/shift/close', { ...withCsrf(csrfToken), data: { counted: rep.cash.expected_cents / 100 } });
  expect(closed.status()).toBe(200);
}

/* Split by items: each person ticks what they had and pays exactly that, with
   its share of the SST; the last share takes whatever is left, and cash is
   rounded to 5 sen only on the payment that settles the bill. The panel
   shows full payment first; paying a specific amount is folded away. */
test('split by items: each person pays for what they had, and the last share takes what is left', async ({ page, request }) => {
  const csrfToken = await apiLogin(request);
  await ensureShift(request, csrfToken);
  await freeCard(request, csrfToken, 13);
  page.on('dialog', dialog => dialog.accept());

  await login(page);
  await openCard(page, 13);
  await addItem(page, 'Roti', 'Roti Canai');
  await addItem(page, 'Mee & Goreng', 'Mee Goreng Mamak');
  await addItem(page, 'Minuman Panas', 'Teh Tarik');
  // A line has no seat button any more: − + 📝 ✕.
  await expect(page.locator('#cart-body').getByRole('button', { name: /seat/i })).toHaveCount(0);
  await page.getByRole('button', { name: /Send 3 new items/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Already sent');

  await page.getByRole('button', { name: /^💵 Take Payment$/ }).click();
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
  // Pay part of the bill is folded away until asked for.
  const part = page.getByRole('button', { name: 'Pay part of the bill' });
  await expect(part).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#pay-amount-row')).toBeHidden();
  await part.click();
  await expect(part).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Pay a specific amount (RM)')).toBeVisible();
  await part.click();
  await expect(page.locator('#pay-amount-row')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Split by seat' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Split by items' }).click();
  const line = name => page.locator('#pay-split-result .split-item', { hasText: name });
  const total = page.locator('#split-items-total');
  const payBy = method => page.locator('#pay-split-result').getByRole('button', { name: method });
  await expect(total).toHaveText('Tick the items this person is paying for.');
  await expect(payBy('Pay card')).toBeDisabled();

  // 13.30 + 0.80 SST = 14.10, so the mee's share is 8.50 × 14.10 / 13.30 = 9.01.
  await line('Mee Goreng Mamak').locator('input').check();
  await expect(total).toContainText('These items: RM 9.01, with their share of service charge and tax.');
  await payBy('Pay card').click();
  await expect(page.locator('#toast')).toContainText('Paid RM 9.01');
  await expect(line('Mee Goreng Mamak')).toContainText('Paid');
  await expect(line('Mee Goreng Mamak').locator('input')).toBeDisabled();

  await line('Roti Canai').locator('input').check();
  await expect(total).toContainText('These items: RM 2.12');
  await payBy('Pay cash').click();
  await expect(line('Roti Canai')).toContainText('Paid');

  // The last share is what is left (2.97, not 2.968 rounded again), and in cash 2.95.
  await line('Teh Tarik').locator('input').check();
  await expect(total).toContainText('These items: RM 2.97');
  await expect(total).toContainText('This is the last share: it takes whatever is left on the bill.');
  await expect(total).toContainText('In cash: RM 2.95.');
  await payBy('Pay cash').click();
  await expect(page.locator('#pos-tables')).toBeVisible();

  const paid = (await request.get('/api/orders?mode=recent').then(r => r.json())).find(o => o.label === 'Card 13');
  expect(paid.status).toBe('paid');
  expect(paid.payments.map(p => [p.method, p.amount])).toEqual([['Card', 9.01], ['Cash', 2.12], ['Cash', 2.95]]);
  expect(paid.grand_total).toBe(14.08);
  expect(paid.rounding).toBe(-0.02);
});

/* Combine = merge: on Card 1, Combine -> Card 4, and Card 4's food moves onto
   Card 1's bill now. The kitchen and the bill call it Card 1 (from 4); Card
   4 is free, a fresh card to a customer scanning it, and the next group
   starts a bill of its own on it. */
test('combine: Card 4\'s items join Card 1\'s bill, and Card 4 starts a new group', async ({ page, request }) => {
  const csrfToken = await apiLogin(request);
  await freeCard(request, csrfToken, 1);
  await freeCard(request, csrfToken, 4);
  const cards = await request.get('/api/admin/cards').then(r => r.json());
  const qr = n => cards.find(c => c.number === n).url;

  await login(page);
  await openCard(page, 1);
  await addItem(page, 'Roti', 'Roti Canai');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Already sent');
  await page.getByRole('button', { name: /Back to Cards/ }).click();
  await openCard(page, 4);
  await addItem(page, 'Mee & Goreng', 'Mee Goreng Mamak');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Already sent');
  await page.getByRole('button', { name: /Back to Cards/ }).click();

  await openCard(page, 1);
  await page.getByRole('button', { name: /Combine bills/ }).click();
  await expect(page.locator('#combine-title')).toHaveText('Combine a card into Card 1');
  await page.locator('#combine-list input[data-label="Card 4"]').check();
  await page.locator('#combine-modal').getByRole('button', { name: 'Combine', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Card 4’s items are now on Card 1’s bill. Card 4 is free.');
  await expect(page.locator('#cart-body')).toContainText('Mee Goreng Mamak');
  await expect(page.locator('.bill-round-head', { hasText: 'Card 1 (from 4)' })).toContainText('Round 1');
  await expect(page.locator('#bill-group')).toContainText('Card 4’s items are on this bill.');
  await expect(page.getByRole('button', { name: 'Separate Card 4' })).toBeVisible();
  await expect(page.locator('#cart-total-rm')).toHaveText('RM 11.13');

  await navTab(page, 'Kitchen').click();
  const ticket = page.locator('#k-col-sent .k-order', { hasText: 'Card 1 (from 4)' });
  await expect(ticket).toContainText('Mee Goreng Mamak');
  await expect(ticket).not.toContainText('Add-on');

  await navTab(page, 'Cards').click();
  await page.getByRole('button', { name: /Back to Cards/ }).click();
  await expect(page.locator('#tables-grid').getByRole('button', { name: /^Card 4\b/ })).toContainText('Free');
  await expect(page.locator('#tables-grid').getByRole('button', { name: /^Card 1\b/ })).toContainText('With Card 4');

  // A customer scanning Card 1 sees the whole bill; scanning Card 4, a fresh card.
  const phone = await page.context().newPage();
  await phone.goto(qr(1));
  await expect(phone.locator('#card-bill')).toContainText('Mee Goreng Mamak');
  await expect(phone.locator('#card-bill')).toContainText('from Card 4');
  await expect(phone.locator('#card-bill')).toContainText('RM 11.13');
  await phone.goto(qr(4));
  await expect(phone.locator('#table-name')).toHaveText('Card 4');
  await expect(phone.locator('#menu-items')).not.toBeEmpty();
  await expect(phone.locator('#card-bill')).toHaveCount(0);
  await phone.close();

  // The next group on Card 4: a bill of its own.
  await openCard(page, 4);
  await expect(page.locator('#cart-empty')).toBeVisible();
  await addItem(page, 'Roti', 'Roti Telur');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Roti Telur');
  await expect(page.locator('#cart-body')).not.toContainText('Mee Goreng Mamak');
  await page.getByRole('button', { name: /Back to Cards/ }).click();

  // So Card 4's earlier items can't go back to it now, and the till says why.
  await openCard(page, 1);
  await page.getByRole('button', { name: 'Separate Card 4' }).click();
  await expect(page.locator('#toast')).toContainText('Card 4 has a new bill of its own now');

  const open = await request.get('/api/orders').then(r => r.json());
  expect(open.find(o => o.label === 'Card 1').items.map(i => [i.name, i.from_card])).toEqual([['Roti Canai', null], ['Mee Goreng Mamak', 4]]);
  expect(open.find(o => o.label === 'Card 4').items.map(i => i.name)).toEqual(['Roti Telur']);
  const merged = (await request.get('/api/orders?mode=recent').then(r => r.json())).find(o => o.status === 'merged');
  expect(merged.label).toBe('Card 4');
  expect(merged.items).toEqual([]);
});

/* Review D1: a Combine made on another till while this pay screen is open.
   The screen catches up with the new total before any money is taken, and
   the server refuses a pay-in-full at a total the till no longer shows. */
async function openByApi(request, csrfToken, number, itemName) {
  const cards = await request.get('/api/admin/cards').then(r => r.json());
  const menu = await request.get('/api/menu').then(r => r.json());
  const r = await request.post('/api/orders', {
    ...withCsrf(csrfToken),
    data: { card_id: cards.find(c => c.number === number).id, items: [{ item_id: menu.items.find(i => i.name === itemName).id, qty: 1 }] },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).id;
}

test('a Combine on another till while the pay screen is open: the screen shows the new total before any money is taken', async ({ page, request }) => {
  const csrfToken = await apiLogin(request);
  for (const n of [31, 32]) await freeCard(request, csrfToken, n);
  await ensureShift(request, csrfToken);
  const c31 = await openByApi(request, csrfToken, 31, 'Roti Canai');
  const c32 = await openByApi(request, csrfToken, 32, 'Mee Goreng Mamak');

  page.on('dialog', dialog => dialog.accept());
  await login(page);
  await openCard(page, 31);
  await page.getByRole('button', { name: /^💵 Take Payment$/ }).click();
  await expect(page.locator('#pay-details')).toContainText('RM 2.12');

  const m = await request.post(`/api/orders/${c31}/merge`, { ...withCsrf(csrfToken), data: { from_order_id: c32 } });
  expect(m.status()).toBe(200);
  await expect(page.locator('#toast')).toContainText('The bill changed on another till — it is now RM 11.13');
  await expect(page.locator('#pay-details')).toContainText('RM 11.13');

  // A till that still sends the old total is refused, and nothing is taken.
  const stale = await request.post(`/api/orders/${c31}/pay`, { ...withCsrf(csrfToken), data: { method: 'Cash', expected_due: 2.12 } });
  expect(stale.status()).toBe(409);

  await page.locator('#pay-modal').getByRole('button', { name: '💵 Cash', exact: true }).click();
  await expect(page.locator('#pos-tables')).toBeVisible();
  const paid = (await request.get('/api/orders?mode=recent').then(r => r.json())).find(o => o.id === c31);
  expect(paid.status).toBe('paid');
  expect(paid.payments.map(p => p.amount)).toEqual([11.15]);
});

/* Review D3: an add-on queued offline for a card that another till combines
   meanwhile can't land. It is listed on the till as not sent, with the
   reason, until someone taps OK — never silently dropped. */
test('an add-on for a card combined meanwhile is listed as not sent, never silently lost', async ({ page, context, request }) => {
  const csrfToken = await apiLogin(request);
  for (const n of [33, 34]) await freeCard(request, csrfToken, n);
  const c33 = await openByApi(request, csrfToken, 33, 'Roti Canai');
  const c34 = await openByApi(request, csrfToken, 34, 'Roti Telur');

  await login(page);
  await openCard(page, 33);
  await context.setOffline(true);
  await addItem(page, 'Minuman Panas', 'Teh Tarik');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#offline-banner')).toContainText('1 order');

  const m = await request.post(`/api/orders/${c34}/merge`, { ...withCsrf(csrfToken), data: { from_order_id: c33 } });
  expect(m.status()).toBe(200);
  await context.setOffline(false);

  const box = page.locator('#outbox-failed');
  await expect(box).toBeVisible();
  await expect(box).toContainText('Not sent — Card 33');
  await expect(box).toContainText('1× Teh Tarik');
  await expect(box).toContainText('Card 34');
  await box.getByRole('button', { name: 'OK' }).click();
  await expect(box).toBeHidden();
  const open = await request.get('/api/orders').then(r => r.json());
  expect(open.find(o => o.id === c34).items.map(i => i.name).sort()).toEqual(['Roti Canai', 'Roti Telur']);
});

/* Clear sales data: with every bill, shift and kitchen ticket finished, the
   owner clears from Admin -> System with their PIN and the word CLEAR, and
   the Sales screen reads RM0. Running the wizard again first changes settings
   only — its last page says where clearing lives. */
test('clear sales data: running setup keeps the sales, clearing starts every figure from RM0', async ({ page, request }) => {
  const csrfToken = await apiLogin(request);
  await ensureShift(request, csrfToken);
  const menu = await request.get('/api/menu').then(r => r.json());
  const roti = menu.items.find(i => i.name === 'Roti Canai');
  const ta = await request.post('/api/orders', { ...withCsrf(csrfToken), data: { order_type: 'takeaway', items: [{ item_id: roti.id, qty: 2 }] } });
  await payOpenBill(request, csrfToken, await ta.json());
  await settleShop(request, csrfToken);
  const before = await request.get('/api/dashboard').then(r => r.json());
  expect(before.today.sales).toBeGreaterThan(0);

  await login(page);
  await navTab(page, 'Admin').click();
  await page.locator('#admin-tabs').getByRole('button', { name: /Features & setup/ }).click();
  await page.getByRole('button', { name: 'Run setup again' }).click();
  const wizard = page.locator('#setup-modal');
  await expect(wizard).toBeVisible();
  if (!(await page.locator('#setup-name').inputValue())) await page.locator('#setup-name').fill('Gerai Pak Ali');
  for (let i = 0; i < 8 && !(await wizard.getByRole('button', { name: 'Finish setup' }).isVisible()); i++) {
    await wizard.getByRole('button', { name: 'Next' }).click();
  }
  await expect(page.locator('#setup-sales-kept')).toHaveText('Your sales history is kept. To start from RM0, use Admin → System → Clear sales data.');
  await wizard.getByRole('button', { name: 'Finish setup' }).click();
  await expect(wizard).toBeHidden();
  expect((await request.get('/api/dashboard').then(r => r.json())).today).toEqual(before.today);

  await page.locator('#admin-tabs').getByRole('button', { name: /System/ }).click();
  await expect(page.locator('#clear-sales-status')).toContainText('would move into an archive');
  await page.locator('#clear-sales-open').click();
  const modal = page.locator('#clear-sales-modal');
  await expect(modal.locator('#clear-sales-summary')).toContainText('every sales figure starts again from RM0');
  await modal.locator('#clear-sales-pin').fill('1234');
  await modal.locator('#clear-sales-confirm').fill('clear');
  await modal.getByRole('button', { name: 'Clear sales data' }).click();
  await expect(modal.locator('#clear-sales-err')).toHaveText('Type CLEAR, in capitals, to confirm.');
  await modal.locator('#clear-sales-confirm').fill('CLEAR');
  await modal.getByRole('button', { name: 'Clear sales data' }).click();
  await expect(modal).toBeHidden();
  await expect(page.locator('#toast')).toContainText(/Sales cleared\. The old figures are kept in archive_\d{8}_\d{6}/);
  await expect(page.locator('#clear-sales-status')).toContainText('There are no sales to clear');

  await navTab(page, 'Sales').click();
  const kpi = label => page.locator('#dash-kpis .kpi', { hasText: label }).locator('.v');
  await expect(kpi('Today sales')).toHaveText('RM 0.00');
  await expect(kpi('Orders')).toHaveText('0');
  await expect(kpi('This month')).toHaveText('RM 0.00');
  await expect(kpi('This year')).toHaveText('RM 0.00');
  await expect(page.locator('#dash-top')).toContainText('Nothing yet today');

  const dash = await request.get('/api/dashboard').then(r => r.json());
  expect([dash.today.sales, dash.today.orders, dash.month.sales, dash.year.sales]).toEqual([0, 0, 0, 0]);
  const summary = await request.get('/api/summary').then(r => r.json());
  expect([summary.today.sales, summary.month.sales, summary.year.sales]).toEqual([0, 0, 0]);
  const [audit] = await request.get('/api/admin/audit?action=sales.clear').then(r => r.json());
  expect(audit.user_name).toBe('Admin');
  expect(audit.detail.archive).toMatch(/^archive_\d{8}_\d{6}/);
  expect(audit.detail.bills).toBeGreaterThan(0);
});

test('void a line', async ({ page }) => {
  await login(page);

  // Two lines, not one — voiding the only line on an unpaid order drops its
  // total to zero, which equals what's already paid (nothing) and auto-settles
  // it. A second line keeps the order open through the void.
  await openCard(page, 4);
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

  await openCard(page, 6);
  await addItem(page, 'Roti', 'Roti Canai');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#cart-body')).toContainText('Sending');
  await expect(page.locator('#offline-banner')).toBeVisible();
  await expect(page.locator('#offline-banner')).toContainText('1 order');

  await page.getByRole('button', { name: /Back to Cards/ }).click();
  await openCard(page, 7);
  await addItem(page, 'Roti', 'Roti Telur');
  await page.getByRole('button', { name: /Send 1 new item/ }).click();
  await expect(page.locator('#offline-banner')).toContainText('2 orders');

  await context.setOffline(false);
  await expect(page.locator('#offline-banner')).toBeHidden();
  await expect(page.locator('#cart-body')).toContainText('Already sent');

  await apiLogin(request);
  const orders = await request.get('/api/orders').then(r => r.json());
  const t6 = orders.find(o => o.label === 'Card 6');
  const t7 = orders.find(o => o.label === 'Card 7');
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
  const cards = await request.get('/api/admin/cards').then(r => r.json());
  const c5 = cards.find(c => c.number === 5);

  await page.goto(c5.url);
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
  // for. (Scoped to this card: the suite shares one database.)
  const before = await request.get('/api/orders').then(r => r.json());
  expect(before.find(o => o.label === 'Card 5')).toBeUndefined();

  // The customer edits, then confirms.
  await page.locator('#vs-lines .qty button').first().click();   // one fewer roti
  await expect(page.locator('#vs-total')).toHaveText(`RM ${(roti.price + teh.price).toFixed(2)}`);
  await page.getByRole('button', { name: 'Confirm order' }).click();

  await expect(page.getByRole('heading', { name: 'Order sent' })).toBeVisible({ timeout: 15000 });

  const orders = await request.get('/api/orders').then(r => r.json());
  const order = orders.find(o => o.label === 'Card 5');
  expect(order.source).toBe('qr');
  expect(order.sends.length).toBe(1);
  expect(order.items.map(i => i.name).sort()).toEqual(['Roti Canai', 'Teh Tarik']);
  expect(order.subtotal).toBeCloseTo(roti.price + teh.price, 2);
});

test('a spoken order the customer abandons leaves nothing behind', async ({ page, request }) => {
  await apiLogin(request);
  const cards = await request.get('/api/admin/cards').then(r => r.json());
  const c6 = cards.find(c => c.number === 6);

  // The suite shares one database and earlier journeys have left orders on the
  // floor, so the assertion is "nothing changed", not "nothing exists".
  const before = await request.get('/api/orders').then(r => r.json());

  await page.goto(c6.url);
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
