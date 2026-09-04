const { test, expect } = require('@playwright/test');

// Six journeys, per docs/prompts/_CONVENTIONS.md's Testing section. Five are
// implemented; "void a line" is still marked pending (a pre-existing gap from
// phase 03, not touched by phase 09).

test('staff login → order → kitchen → pay', async ({ page, request }) => {
  // Phase 09: a payment is refused unless a shift is open.
  const login = await request.post('/api/login', { data: { name: 'Admin', pin: '1234' } });
  const { token } = await login.json();
  await request.post('/api/shift/open', { headers: { Authorization: `Bearer ${token}` }, data: { float: 0 } });

  await page.goto('/');
  await page.locator('#lname').fill('Admin');
  await page.locator('#lpin').fill('1234');
  await page.getByRole('button', { name: 'Log In' }).click();

  await expect(page.locator('#uname')).toHaveText(/Admin/);

  await page.getByRole('button', { name: 'T1', exact: true }).click();
  await page.getByRole('button', { name: 'Roti', exact: true }).click();
  await page.getByRole('button', { name: /Roti Canai/ }).click();
  await page.getByRole('button', { name: 'Skip' }).click();

  await expect(page.locator('#cart-lines')).toContainText('Roti Canai');
  await page.getByRole('button', { name: 'Send to Kitchen' }).click();
  await expect(page.locator('#cart-lines')).toContainText('sent');

  await page.getByRole('button', { name: 'Kitchen', exact: true }).click();
  await expect(page.locator('#kitchen-active')).toContainText('T1');
  await expect(page.locator('#kitchen-active')).toContainText('Roti Canai');

  await page.getByRole('button', { name: 'Cooking' }).click();
  await expect(page.getByRole('button', { name: 'Ready' })).toBeEnabled();
  await page.getByRole('button', { name: 'Ready' }).click();
  await expect(page.getByRole('button', { name: 'Served' })).toBeEnabled();
  await page.getByRole('button', { name: 'Served' }).click();
  await expect(page.locator('#kitchen-served-list')).toContainText('T1');

  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await page.getByRole('button', { name: 'Mark Paid' }).click();
  // exact: true — phase 05's payment modal added a "pay a specific amount" section
  // whose per-method buttons also contain the word "Cash" as a substring.
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark Paid' })).toBeHidden();
});

test('QR customer order', async ({ page, request }) => {
  const login = await request.post('/api/login', { data: { name: 'Admin', pin: '1234' } });
  const { token } = await login.json();
  const tables = await request.get('/api/admin/tables', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  const t2 = tables.find(t => t.name === 'T2');

  await page.goto(t2.url);
  await expect(page.locator('#table-name')).toHaveText('T2');

  await page.getByRole('button', { name: 'Roti', exact: true }).click();
  await page.getByRole('button', { name: /Roti Telur/ }).click();
  await page.getByRole('button', { name: 'Skip' }).click();

  await expect(page.locator('#bar-count')).toHaveText('1');
  await page.getByRole('button', { name: 'View Order' }).click();
  await expect(page.locator('#cart-lines')).toContainText('Roti Telur');
  await page.getByRole('button', { name: 'Place Order' }).click();

  await expect(page.getByText('Order Placed!')).toBeVisible();
});

test('split bill', async ({ page, request }) => {
  // Phase 09: a payment is refused unless a shift is open — don't assume an
  // earlier journey left one open, since these tests can run standalone.
  const login = await request.post('/api/login', { data: { name: 'Admin', pin: '1234' } });
  const { token } = await login.json();
  const authHeaders = { Authorization: `Bearer ${token}` };
  const existingShift = await request.get('/api/shift/current', { headers: authHeaders }).then(r => r.json());
  if (!existingShift) await request.post('/api/shift/open', { headers: authHeaders, data: { float: 0 } });

  // The order stays 'sent' throughout (never advanced through the kitchen), so
  // "Mark Paid" fires the "food still cooking?" confirm() — accept it — and
  // "Split evenly" fires a prompt() for the number of ways — answer "2".
  page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? '2' : undefined));

  await page.goto('/');
  await page.locator('#lname').fill('Admin');
  await page.locator('#lpin').fill('1234');
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page.locator('#uname')).toHaveText(/Admin/);

  await page.getByRole('button', { name: 'T3', exact: true }).click();
  await page.getByRole('button', { name: 'Roti', exact: true }).click();
  await page.getByRole('button', { name: /Roti Canai/ }).click();
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: /Roti Canai/ }).click();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('#cart-lines')).toContainText('2×');

  await page.getByRole('button', { name: 'Send to Kitchen' }).click();
  await expect(page.locator('#cart-lines')).toContainText('sent');

  await page.getByRole('button', { name: 'Mark Paid' }).click();
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
  await page.getByRole('button', { name: 'Split evenly' }).click();
  await expect(page.locator('#pay-split-result')).toContainText('Share 1');
  await expect(page.locator('#pay-split-result')).toContainText('Share 2');

  await page.getByRole('button', { name: 'Pay cash' }).first().click();
  await expect(page.locator('#pay-split-result')).not.toContainText('Share 1');
  await expect(page.locator('#pay-split-result')).toContainText('Share 2');

  await page.getByRole('button', { name: 'Pay cash' }).first().click();
  await expect(page.getByRole('button', { name: 'Mark Paid' })).toBeHidden();
});

test('void a line', async () => {
  test.skip(true, 'Per-line void with reason lands in phase 03 — see docs/prompts/phase-03-order-integrity.md');
});

test('offline order reconciles', async ({ page, context, request }) => {
  await page.goto('/');
  await page.locator('#lname').fill('Admin');
  await page.locator('#lpin').fill('1234');
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page.locator('#uname')).toHaveText(/Admin/);

  await context.setOffline(true);

  await page.getByRole('button', { name: 'T6', exact: true }).click();
  await page.getByRole('button', { name: 'Roti', exact: true }).click();
  await page.getByRole('button', { name: /Roti Canai/ }).click();
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: 'Send to Kitchen' }).click();
  await expect(page.locator('#cart-lines')).toContainText('pending');
  await expect(page.locator('#offline-banner')).toBeVisible();
  await expect(page.locator('#offline-banner')).toContainText('1 order');

  await page.getByRole('button', { name: 'Back to Tables' }).click();
  await page.getByRole('button', { name: 'T7', exact: true }).click();
  await page.getByRole('button', { name: 'Roti', exact: true }).click();
  await page.getByRole('button', { name: /Roti Telur/ }).click();
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: 'Send to Kitchen' }).click();
  await expect(page.locator('#cart-lines')).toContainText('pending');
  await expect(page.locator('#offline-banner')).toContainText('2 orders');

  await context.setOffline(false);

  await expect(page.locator('#offline-banner')).toBeHidden();
  await expect(page.locator('#cart-lines')).toContainText('sent');

  const login = await request.post('/api/login', { data: { name: 'Admin', pin: '1234' } });
  const { token } = await login.json();
  const orders = await request.get('/api/orders', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());

  const t6 = orders.find(o => o.table === 'T6');
  const t7 = orders.find(o => o.table === 'T7');
  expect(t6).toBeTruthy();
  expect(t7).toBeTruthy();
  expect(t6.items.some(i => i.name === 'Roti Canai')).toBe(true);
  expect(t7.items.some(i => i.name === 'Roti Telur')).toBe(true);
});

test('shift open → close', async ({ page, request }) => {
  // Close whatever shift an earlier journey left open, so this one exercises
  // a clean open → close cycle of its own end to end through the UI.
  const login = await request.post('/api/login', { data: { name: 'Admin', pin: '1234' } });
  const { token } = await login.json();
  const authHeaders = { Authorization: `Bearer ${token}` };
  const existingShift = await request.get('/api/shift/current', { headers: authHeaders }).then(r => r.json());
  if (existingShift) {
    const rep = await request.get(`/api/shift/${existingShift.id}/report`, { headers: authHeaders }).then(r => r.json());
    await request.post('/api/shift/close', { headers: authHeaders, data: { counted: rep.cash.expected_cents / 100 } });
  }

  await page.goto('/');
  await page.locator('#lname').fill('Admin');
  await page.locator('#lpin').fill('1234');
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page.locator('#uname')).toHaveText(/Admin/);

  await page.getByRole('button', { name: 'Shift', exact: true }).click();
  await expect(page.locator('#shift-closed-card')).toBeVisible();

  await page.locator('#shift-float-input').fill('200');
  await page.getByRole('button', { name: 'Open Shift' }).click();
  await expect(page.locator('#shift-open-card')).toBeVisible();
  await expect(page.locator('#shift-status')).toContainText('RM 200.00');

  await page.getByRole('button', { name: 'Close Shift' }).click();
  await expect(page.locator('#shift-close-form')).toBeVisible();
  // 4 x RM50 = RM 200.00, exactly matching the float with no sales in between -> variance 0.
  await page.locator('[data-cents="5000"]').fill('4');
  await expect(page.locator('#denom-total')).toHaveText('RM 200.00');

  await page.getByRole('button', { name: 'Confirm Close' }).click();
  await expect(page.locator('#shift-report-card')).toBeVisible();
  await expect(page.locator('#shift-variance-badge')).toContainText('RM 0.00');
  await expect(page.locator('#shift-closed-card')).toBeVisible();
});
