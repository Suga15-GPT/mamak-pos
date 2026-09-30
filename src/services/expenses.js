const { pool } = require('../db');
const { AppError } = require('../lib/errors');
const { writeAudit } = require('./orders');

/* ===== Expenses =====
   What the restaurant spends, kept apart from sales. The owner records a
   purchase by typing it, by photographing the receipt, or by saying it into
   the phone; a photo or voice note is read by a model into a *draft* that the
   owner checks and saves — the model never saves anything itself, the same
   rule Speak to Order follows (services/voice.js).

   Reading receipts uses Google's Gemini API (GEMINI_API_KEY; the free tier is
   enough for a restaurant's handful of receipts a day). Unconfigured, the
   screen still works: typing an expense needs no model at all.

   Money is integer cents. Dates are shop dates (KL). */

const KL = 'Asia/Kuala_Lumpur';
const METHODS = ['Cash', 'Card', 'Bank transfer', 'DuitNow/eWallet', 'Other'];
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const AUDIO_MIMES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/x-m4a'];
const MAX_UPLOAD = 3 * 1024 * 1024;
const MAX_CENTS = 10_000_000; // RM 100,000: no single purchase here is bigger
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const todayKL = () => new Intl.DateTimeFormat('en-CA', { timeZone: KL }).format(new Date());
const clean = (s, max = 120) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return v || null;
};
function validDate(s) {
  if (!DATE.test(String(s))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function cents(rm) {
  const n = Number(rm);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/* ===== Categories ===== */
async function categories(client = pool) {
  return (await client.query('SELECT id, name FROM expense_categories WHERE active ORDER BY sort, name')).rows;
}

/* ===== Recording ===== */

// The fields an expense is made of, checked the same way whether they come
// from the form, a draft or a regular cost.
async function checkFields(b, client = pool, { partial = false } = {}) {
  const out = {};
  if (!partial || b.spent_on !== undefined) {
    if (!validDate(b.spent_on)) throw AppError('Pick the date of the purchase.', 400);
    if (b.spent_on > todayKL()) throw AppError('That date is in the future.', 400);
    out.spent_on = b.spent_on;
  }
  if (!partial || b.amount !== undefined) {
    const c = cents(b.amount);
    if (!(c > 0)) throw AppError('Enter how much it cost.', 400);
    if (c > MAX_CENTS) throw AppError('That amount looks too big — check it.', 400);
    out.amount_cents = c;
  }
  if (!partial || b.method !== undefined) {
    const m = b.method || 'Cash';
    if (!METHODS.includes(m)) throw AppError('Pick how it was paid.', 400);
    out.method = m;
  }
  if (!partial || b.category_id !== undefined) {
    if (b.category_id == null || b.category_id === '') out.category_id = null;
    else {
      const id = Number(b.category_id);
      const ok = Number.isInteger(id) && (await client.query('SELECT 1 FROM expense_categories WHERE id = $1', [id])).rows[0];
      if (!ok) throw AppError('Pick a category.', 400);
      out.category_id = id;
    }
  }
  if (!partial || b.supplier !== undefined) out.supplier = clean(b.supplier, 80);
  if (!partial || b.description !== undefined) out.description = clean(b.description, 200);
  if (!partial || b.items !== undefined) out.items = cleanItems(b.items);
  return out;
}

function cleanItems(items) {
  if (!Array.isArray(items) || !items.length) return null;
  return items.slice(0, 50).map(i => ({
    name: clean(i?.name, 80) || 'Item',
    qty: Number.isFinite(Number(i?.qty)) && Number(i.qty) > 0 ? Math.min(9999, Number(i.qty)) : null,
    amount_cents: (() => { const c = cents(i?.amount ?? (i?.amount_cents != null ? i.amount_cents / 100 : null)); return c > 0 && c <= MAX_CENTS ? c : null; })(),
  }));
}

async function create(body, userId) {
  const f = await checkFields(body);
  const source = ['manual', 'photo', 'voice'].includes(body.source) ? body.source : 'manual';
  let receiptId = null;
  if (body.receipt_id != null) {
    receiptId = Number(body.receipt_id);
    if (!(await pool.query('SELECT 1 FROM expense_receipts WHERE id = $1', [receiptId])).rows[0]) throw AppError('That receipt photo is no longer here — take it again.', 400);
  }
  const r = (await pool.query(
    `INSERT INTO expenses (spent_on, supplier, category_id, description, amount_cents, method, items, source, receipt_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [f.spent_on, f.supplier, f.category_id, f.description, f.amount_cents, f.method, f.items ? JSON.stringify(f.items) : null, source, receiptId, userId])).rows[0];
  await writeAudit(pool, { userId, action: 'expense.create', entityType: 'expense', entityId: r.id, detail: { ...f, source, receipt_id: receiptId } });
  return r.id;
}

async function update(id, body, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const e = (await client.query('SELECT * FROM expenses WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!e) throw AppError('expense not found', 404);
    if (e.voided_at) throw AppError('This expense was voided — record it again instead.', 409);
    const f = await checkFields(body, client, { partial: true });
    const keys = Object.keys(f);
    if (!keys.length) throw AppError('Nothing to change.', 400);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    await client.query(`UPDATE expenses SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
      [id, ...keys.map(k => (k === 'items' && f[k] ? JSON.stringify(f[k]) : f[k]))]);
    const before = Object.fromEntries(keys.map(k => [k, e[k] instanceof Date ? e[k].toISOString().slice(0, 10) : e[k]]));
    await writeAudit(client, { userId, action: 'expense.update', entityType: 'expense', entityId: id, detail: { before, after: f } });
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

async function voidExpense(id, reason, userId) {
  const why = clean(reason, 200);
  if (!why || why.length < 3) throw AppError('Say why (at least 3 letters).', 400);
  const r = await pool.query(
    'UPDATE expenses SET voided_at = now(), voided_by = $2, void_reason = $3, updated_at = now() WHERE id = $1 AND voided_at IS NULL RETURNING amount_cents',
    [id, userId, why]);
  if (!r.rows[0]) {
    const exists = (await pool.query('SELECT 1 FROM expenses WHERE id = $1', [id])).rows[0];
    throw AppError(exists ? 'This expense is already voided.' : 'expense not found', exists ? 409 : 404);
  }
  await writeAudit(pool, { userId, action: 'expense.void', entityType: 'expense', entityId: id, detail: { reason: why, amount_cents: r.rows[0].amount_cents } });
}

/* One month's expenses, newest first, with the month's total by category. */
async function list(month) {
  const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : todayKL().slice(0, 7);
  const from = `${m}-01`;
  const rows = (await pool.query(
    `SELECT e.id, to_char(e.spent_on, 'YYYY-MM-DD') spent_on, e.supplier, e.description, e.amount_cents, e.method, e.items,
            e.source, e.receipt_id, e.recurring_id, e.category_id, c.name category, u.name created_by_name,
            e.voided_at, e.void_reason
       FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id LEFT JOIN users u ON u.id = e.created_by
      WHERE e.spent_on >= $1::date AND e.spent_on < ($1::date + interval '1 month')
      ORDER BY e.spent_on DESC, e.id DESC`, [from])).rows;
  const live = rows.filter(r => !r.voided_at);
  const byCat = {};
  live.forEach(r => { const k = r.category || 'Uncategorised'; byCat[k] = (byCat[k] || 0) + r.amount_cents; });
  return {
    month: m,
    expenses: rows.map(r => ({ ...r, amount: r.amount_cents / 100, voided: !!r.voided_at })),
    total_cents: live.reduce((t, r) => t + r.amount_cents, 0),
    by_category: Object.entries(byCat).map(([name, c]) => ({ name, cents: c })).sort((a, b) => b.cents - a.cents),
  };
}

/* Purchases made often, to record again in one tap: the last few distinct
   supplier + category + description, with the amount paid last time. */
async function recent() {
  return (await pool.query(
    `SELECT DISTINCT ON (lower(COALESCE(supplier,'')), category_id, lower(COALESCE(description,'')))
            supplier, category_id, description, amount_cents, method, spent_on
       FROM expenses WHERE voided_at IS NULL AND recurring_id IS NULL
      ORDER BY lower(COALESCE(supplier,'')), category_id, lower(COALESCE(description,'')), spent_on DESC, id DESC`)).rows
    .sort((a, b) => (b.spent_on - a.spent_on))
    .slice(0, 8)
    .map(r => ({ supplier: r.supplier, category_id: r.category_id, description: r.description, amount: r.amount_cents / 100, method: r.method }));
}

/* ===== Regular costs ===== */

const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

// The due dates of a regular cost after `after` (exclusive) up to `until`.
function occurrences(t, after, until, max = 60) {
  const out = [];
  if (t.every === 'week') {
    let d = addDays(after, 1);
    // ISO weekday: Monday 1 … Sunday 7.
    while (d <= until && out.length < max) {
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
      if (wd === t.day) { out.push(d); d = addDays(d, 7); } else d = addDays(d, 1);
    }
    return out;
  }
  let [y, m] = addDays(after, 1).split('-').map(Number);
  for (let i = 0; i < max + 2 && out.length < max; i++) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(t.day, last)).padStart(2, '0')}`;
    if (d > until) break;
    if (d > after) out.push(d);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function shapeRecurring(r) {
  const s = d => (d instanceof Date ? iso(d) : d);
  return {
    id: r.id, name: r.name, supplier: r.supplier, category_id: r.category_id, category: r.category || null,
    amount: r.amount_cents / 100, method: r.method, every: r.every, day: r.day,
    starts_on: s(r.starts_on), last_done_for: r.last_done_for ? s(r.last_done_for) : null, active: r.active,
  };
}

/* What is due now: for each active regular cost, its earliest due date not
   yet recorded or skipped, and how many more are waiting behind it. */
async function due(client = pool) {
  const today = todayKL();
  const rows = (await client.query(
    `SELECT r.*, c.name category FROM recurring_expenses r LEFT JOIN expense_categories c ON c.id = r.category_id
      WHERE r.active ORDER BY r.id`)).rows.map(shapeRecurring);
  return rows.map(t => {
    const after = t.last_done_for || addDays(t.starts_on, -1);
    const dates = occurrences(t, after, today);
    return dates.length ? { ...t, due_for: dates[0], more: dates.length - 1 } : null;
  }).filter(Boolean);
}

async function listRecurring() {
  return (await pool.query(
    `SELECT r.*, c.name category FROM recurring_expenses r LEFT JOIN expense_categories c ON c.id = r.category_id
      ORDER BY r.active DESC, r.name`)).rows.map(shapeRecurring);
}

async function createRecurring(b, userId) {
  const name = clean(b.name, 80);
  if (!name) throw AppError('Give it a name, e.g. "Rent".', 400);
  const every = b.every === 'week' ? 'week' : 'month';
  const day = Number(b.day);
  if (!Number.isInteger(day) || (every === 'month' ? day < 1 || day > 31 : day < 1 || day > 7)) {
    throw AppError(every === 'month' ? 'Pick a day of the month (1–31).' : 'Pick a day of the week.', 400);
  }
  const f = await checkFields({ ...b, spent_on: todayKL() }, pool);
  const starts = validDate(b.starts_on) ? b.starts_on : todayKL();
  const r = (await pool.query(
    `INSERT INTO recurring_expenses (name, supplier, category_id, amount_cents, method, every, day, starts_on, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [name, f.supplier, f.category_id, f.amount_cents, f.method, every, day, starts, userId])).rows[0];
  await writeAudit(pool, { userId, action: 'expense.recurring_create', entityType: 'recurring_expense', entityId: r.id, detail: { name, every, day, amount_cents: f.amount_cents } });
  return r.id;
}

async function updateRecurring(id, b, userId) {
  const sets = [], vals = [id];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.active !== undefined) add('active', !!b.active);
  if (b.amount !== undefined) {
    const c = cents(b.amount);
    if (!(c > 0) || c > MAX_CENTS) throw AppError('Enter how much it costs.', 400);
    add('amount_cents', c);
  }
  if (b.name !== undefined) { const n = clean(b.name, 80); if (!n) throw AppError('Give it a name.', 400); add('name', n); }
  if (!sets.length) throw AppError('Nothing to change.', 400);
  const r = await pool.query(`UPDATE recurring_expenses SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, vals);
  if (!r.rows[0]) throw AppError('not found', 404);
  await writeAudit(pool, { userId, action: 'expense.recurring_update', entityType: 'recurring_expense', entityId: id, detail: b });
}

/* Records (or skips) the regular cost due on `forDate`. Only the earliest
   date still due can be done, one at a time, under a row lock — so two
   phones pressing Record at once make one expense, and none is skipped over. */
async function settleDue(id, { forDate, amount, skip = false }, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t0 = (await client.query('SELECT * FROM recurring_expenses WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!t0) throw AppError('not found', 404);
    const t = shapeRecurring(t0);
    if (!t.active) throw AppError('This regular cost is switched off.', 409);
    const next = occurrences(t, t.last_done_for || addDays(t.starts_on, -1), todayKL(), 1)[0];
    if (!next) throw AppError(`${t.name} is not due yet.`, 409);
    if (forDate !== next) throw AppError(`The next ${t.name} due is for ${next}. Do that one first.`, 409);
    let expenseId = null;
    if (!skip) {
      const c = amount != null ? cents(amount) : t0.amount_cents;
      if (!(c > 0) || c > MAX_CENTS) throw AppError('Enter how much it cost.', 400);
      expenseId = (await client.query(
        `INSERT INTO expenses (spent_on, supplier, category_id, description, amount_cents, method, source, recurring_id, recurring_for, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'recurring',$7,$1,$8) RETURNING id`,
        [next, t.supplier, t.category_id, t.name, c, t.method, id, userId])).rows[0].id;
    }
    await client.query('UPDATE recurring_expenses SET last_done_for = $2 WHERE id = $1', [id, next]);
    await writeAudit(client, {
      userId, action: skip ? 'expense.recurring_skip' : 'expense.recurring_record', entityType: 'recurring_expense', entityId: id,
      detail: { for: next, expense_id: expenseId },
    });
    await client.query('COMMIT');
    return { expense_id: expenseId, for: next };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/* ===== Reading a receipt photo or a voice note ===== */

const DRAFT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    date: { type: 'STRING', nullable: true, description: 'Purchase date as YYYY-MM-DD, or null if not stated' },
    supplier: { type: 'STRING', nullable: true, description: 'Shop or supplier name' },
    total: { type: 'NUMBER', nullable: true, description: 'Total actually paid, in RM' },
    category: { type: 'STRING', nullable: true, description: 'One of the given categories' },
    method: { type: 'STRING', nullable: true, description: 'Cash, Card, Bank transfer, DuitNow/eWallet or Other' },
    description: { type: 'STRING', nullable: true, description: 'A few words: what was bought' },
    items: {
      type: 'ARRAY', nullable: true,
      items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, qty: { type: 'NUMBER', nullable: true }, amount: { type: 'NUMBER', nullable: true } }, required: ['name'] },
    },
  },
};

function prompt(cats, today, kind) {
  return [
    'You record purchases for a Malaysian mamak restaurant.',
    kind === 'image'
      ? 'Read this receipt or invoice photo.'
      : 'Listen to this voice note about something the restaurant bought. It may be in English, Malay, Tamil or a mix ("beli ayam 20 kilo kat pasar, RM180 cash").',
    `Today is ${today}. Amounts are in Malaysian ringgit (RM).`,
    'Return: date (YYYY-MM-DD; for a voice note that does not say, use today), supplier, total (the amount actually paid, after any discount and including SST), category, method, description and items.',
    `category must be exactly one of: ${cats.join(' | ')}.`,
    'method must be one of: Cash | Card | Bank transfer | DuitNow/eWallet | Other, or null if unknown.',
    'Never guess a number you cannot read or hear clearly — use null for it.',
  ].join('\n');
}

// Gemini's generateContent (REST). The key is read from the server's
// environment and never leaves it; the model is a setting because Google
// renames and retires models.
async function geminiExtract({ kind, mime, data, categories: cats, today }) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  const url = process.env.GEMINI_URL || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt(cats, today, kind) }, { inline_data: { mime_type: mime, data } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: DRAFT_SCHEMA },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || `HTTP ${res.status}`;
      throw AppError(res.status === 429
        ? 'The free reading limit for now is used up — try again in a minute, or type it in.'
        : `Could not read it (${msg}). Type it in instead.`, 502);
    }
    const text = (body?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    try { return JSON.parse(text); } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw AppError('Could not make sense of it. Type it in instead.', 502);
    }
  } catch (e) {
    if (e.name === 'AbortError') throw AppError('Reading it took too long. Try again, or type it in.', 504);
    if (e.status) throw e;
    throw AppError('Could not reach the reading service. Check the internet, or type it in.', 502);
  } finally { clearTimeout(timer); }
}

// For development and the tests: no account anywhere, a fixed answer.
async function mockExtract({ kind }) {
  try { if (process.env.EXPENSE_MOCK_JSON) return JSON.parse(process.env.EXPENSE_MOCK_JSON); } catch { /* fall through */ }
  return kind === 'image'
    ? { date: todayKL(), supplier: 'Pasar Borong Selayang', total: 186.4, category: 'Groceries & produce', method: 'Cash', description: 'Onions, chillies, tomatoes',
        items: [{ name: 'Bawang merah 10kg', qty: 1, amount: 58 }, { name: 'Cili merah 5kg', qty: 1, amount: 72.4 }, { name: 'Tomato 8kg', qty: 1, amount: 56 }] }
    : { date: todayKL(), supplier: 'Pasar', total: 180, category: 'Meat, chicken & seafood', method: 'Cash', description: 'Ayam 20 kilo', items: [] };
}

const providers = {
  extract: (...a) => (process.env.EXPENSE_AI_MODE === 'mock' ? mockExtract(...a) : geminiExtract(...a)),
};
function setProviders(p) { Object.assign(providers, p); }
const aiEnabled = () => process.env.EXPENSE_AI_MODE === 'mock' || !!process.env.GEMINI_API_KEY;

function decodeUpload(u, mimes) {
  if (!u || typeof u.data !== 'string' || !mimes.includes(u.mime)) return null;
  const b64 = u.data.replace(/^data:[^;]+;base64,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length || buf.length > MAX_UPLOAD) return null;
  return buf;
}
function looksLikeImage(buf, mime) {
  if (mime === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8;
  if (mime === 'image/png') return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  return false;
}

/* The model's answer, made safe: every field checked, anything doubtful left
   empty for the owner to fill, the category matched to one that exists. */
function shapeDraft(raw, cats) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const today = todayKL();
  const yearAgo = addDays(today, -366);
  const date = validDate(r.date) && r.date <= today && r.date >= yearAgo ? r.date : today;
  const total = cents(r.total);
  const cat = cats.find(c => c.name.toLowerCase() === String(r.category || '').trim().toLowerCase())
    || cats.find(c => c.name === 'Other') || null;
  return {
    spent_on: date,
    supplier: clean(r.supplier, 80),
    amount: total > 0 && total <= MAX_CENTS ? total / 100 : null,
    category_id: cat ? cat.id : null,
    method: METHODS.includes(r.method) ? r.method : null,
    description: clean(r.description, 200),
    items: (cleanItems(r.items) || []).map(i => ({ name: i.name, qty: i.qty, amount: i.amount_cents != null ? i.amount_cents / 100 : null })),
  };
}

/* A photo (kept, as the receipt) or a voice note (not kept) in; a draft out.
   Nothing is recorded as an expense here. */
async function extract({ image, audio }, userId) {
  if (!aiEnabled()) throw AppError('Reading receipts is not set up on this till (GEMINI_API_KEY). Type it in instead.', 404);
  const kind = image ? 'image' : audio ? 'audio' : null;
  if (!kind) throw AppError('Send a photo or a voice note.', 400);
  const u = image || audio;
  const buf = decodeUpload(u, kind === 'image' ? IMAGE_MIMES : AUDIO_MIMES);
  if (!buf) throw AppError(kind === 'image' ? 'That photo could not be used — try again (under 3 MB).' : 'That recording could not be used — try again (a minute at most).', 400);
  if (kind === 'image' && !looksLikeImage(buf, u.mime)) throw AppError('That file is not a photo.', 400);

  const cats = await categories();
  // A receipt photo nobody saved an expense for within a day is dropped.
  await pool.query(`DELETE FROM expense_receipts r WHERE r.created_at < now() - interval '1 day'
                     AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.receipt_id = r.id)`);
  const receiptId = kind === 'image'
    ? (await pool.query('INSERT INTO expense_receipts (mime, data, created_by) VALUES ($1, $2, $3) RETURNING id', [u.mime, buf, userId])).rows[0].id
    : null;
  const raw = await providers.extract({ kind, mime: u.mime, data: buf.toString('base64'), categories: cats.map(c => c.name), today: todayKL() });
  return { draft: shapeDraft(raw, cats), receipt_id: receiptId, source: kind === 'image' ? 'photo' : 'voice' };
}

async function receipt(id) {
  return (await pool.query('SELECT mime, data FROM expense_receipts WHERE id = $1', [id])).rows[0] || null;
}

/* Expenses by the same buckets the Sales explorer uses (day or month; an
   hour has no expenses — they are dated, not timed). */
async function byBucket(client, from, to, bucket) {
  if (bucket === 'hour') {
    const r = await client.query(
      'SELECT COALESCE(SUM(amount_cents), 0)::bigint s FROM expenses WHERE voided_at IS NULL AND spent_on BETWEEN $1::date AND $2::date', [from, to]);
    return { total_cents: Number(r.rows[0].s), rows: null };
  }
  const rows = (await client.query(
    `SELECT to_char(date_trunc($3, spent_on::timestamp), 'YYYY-MM-DD"T"HH24:00') k, SUM(amount_cents)::bigint s
       FROM expenses WHERE voided_at IS NULL AND spent_on BETWEEN $1::date AND $2::date GROUP BY 1`, [from, to, bucket])).rows;
  const map = Object.fromEntries(rows.map(r => [r.k, Number(r.s)]));
  return { total_cents: rows.reduce((t, r) => t + Number(r.s), 0), rows: map };
}

module.exports = {
  METHODS, categories, create, update, voidExpense, list, recent,
  listRecurring, createRecurring, updateRecurring, due, settleDue, occurrences,
  extract, receipt, aiEnabled, setProviders, shapeDraft, byBucket, todayKL,
};
