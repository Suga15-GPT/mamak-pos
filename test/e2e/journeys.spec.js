const { test, expect } = require('@playwright/test');

// Six journeys, per docs/prompts/_CONVENTIONS.md's Testing section. Two are
// fully implemented today; the other four exercise features that land in
// later phases of the rebuild plan and are marked pending until then.

test('staff login → order → kitchen → pay', async ({ page }) => {
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

test('split bill', async ({ page }) => {
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

test('shift open → close', async () => {
  test.skip(true, 'Shift open/close lands in phase 09 — see docs/prompts/phase-09-shifts-reports.md');
});
