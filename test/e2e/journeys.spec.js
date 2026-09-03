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

test('split bill', async () => {
  test.skip(true, 'Split bill / multi-tender payments land in phase 05 — see docs/prompts/phase-05-payments.md');
});

test('void a line', async () => {
  test.skip(true, 'Per-line void with reason lands in phase 03 — see docs/prompts/phase-03-order-integrity.md');
});

test('offline order reconciles', async () => {
  test.skip(true, 'Offline outbox + reconciliation lands in phase 07 — see docs/prompts/phase-07-offline.md');
});

test('shift open → close', async () => {
  test.skip(true, 'Shift open/close lands in phase 09 — see docs/prompts/phase-09-shifts-reports.md');
});
