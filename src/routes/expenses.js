const express = require('express');
const { requireRole } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { requireFeature } = require('../services/features');
const expenses = require('../services/expenses');

/* 🧾 Expenses — the owner's screen (admin only). See services/expenses.js. */
const router = express.Router();
const owner = [requireRole('admin'), requireFeature('expenses')];
const idOf = req => {
  const n = Number(req.params.id);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
};

// Everything the screen needs to start: categories, how things are paid,
// whether receipts can be read, what is due, and purchases to repeat.
router.get('/api/expenses/meta', ...owner, awaitH(async (req, res) => {
  const [categories, due, recent, recurring] = await Promise.all([
    expenses.categories(), expenses.due(), expenses.recent(), expenses.listRecurring()]);
  res.json({ categories, methods: expenses.METHODS, ai_enabled: expenses.aiEnabled(), due, recent, recurring, today: expenses.todayKL() });
}));

router.get('/api/expenses', ...owner, awaitH(async (req, res) => res.json(await expenses.list(req.query.month))));

router.post('/api/expenses', ...owner, awaitH(async (req, res) => {
  res.status(201).json({ id: await expenses.create(req.body || {}, req.user.id) });
}));

router.patch('/api/expenses/:id', ...owner, awaitH(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(404).json({ error: 'not found' });
  await expenses.update(id, req.body || {}, req.user.id);
  res.json({ ok: true });
}));

router.post('/api/expenses/:id/void', ...owner, awaitH(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(404).json({ error: 'not found' });
  await expenses.voidExpense(id, req.body?.reason, req.user.id);
  res.json({ ok: true });
}));

// A photo or voice note in, a draft out. Nothing is recorded here.
router.post('/api/expenses/extract', ...owner, awaitH(async (req, res) => {
  res.json(await expenses.extract(req.body || {}, req.user.id));
}));

router.get('/api/expenses/receipts/:id', ...owner, awaitH(async (req, res) => {
  const id = idOf(req);
  const r = id && await expenses.receipt(id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.set('Cache-Control', 'private, max-age=86400').type(r.mime).send(r.data);
}));

router.post('/api/expenses/recurring', ...owner, awaitH(async (req, res) => {
  res.status(201).json({ id: await expenses.createRecurring(req.body || {}, req.user.id) });
}));

router.patch('/api/expenses/recurring/:id', ...owner, awaitH(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(404).json({ error: 'not found' });
  await expenses.updateRecurring(id, req.body || {}, req.user.id);
  res.json({ ok: true });
}));

router.post('/api/expenses/recurring/:id/record', ...owner, awaitH(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(404).json({ error: 'not found' });
  res.json(await expenses.settleDue(id, { forDate: req.body?.for, amount: req.body?.amount }, req.user.id));
}));

router.post('/api/expenses/recurring/:id/skip', ...owner, awaitH(async (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(404).json({ error: 'not found' });
  res.json(await expenses.settleDue(id, { forDate: req.body?.for, skip: true }, req.user.id));
}));

module.exports = router;
