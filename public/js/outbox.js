// outbox.js — IndexedDB-backed write queue for offline order entry (phase 07).
// The hard requirement: an order is never lost and never sent twice. Entries
// flush in insertion order (an append must never overtake the create it
// belongs to), and every write carries a stable Idempotency-Key across
// retries, so a retried request that actually landed just replays the
// server's original result (see routes/orders.js) instead of duplicating.

const DB_NAME = 'mamak-outbox';
const DB_VERSION = 1;
const QUEUE_STORE = 'queue';
const FAILED_STORE = 'failed';

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(FAILED_STORE)) db.createObjectStore(FAILED_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode) {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const listeners = new Set();
// Fires whenever the queue changes (enqueued, sent, failed) — callers re-read
// pending()/failedEntries() themselves rather than being handed the diff.
export function onOutboxChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { listeners.forEach(fn => fn()); }

/* request: { url, method, body }. Returns immediately — the caller never
   blocks on the network. */
export async function enqueue(request) {
  const id = uuid();
  const entry = { id, url: request.url, method: request.method, body: request.body, key: id, createdAt: Date.now(), attempts: 0 };
  const s = await store(QUEUE_STORE, 'readwrite');
  await reqToPromise(s.add(entry));
  notify();
  flush();
  return entry;
}

export async function pending() {
  const s = await store(QUEUE_STORE, 'readonly');
  return reqToPromise(s.getAll());
}

export async function failedEntries() {
  const s = await store(FAILED_STORE, 'readonly');
  return reqToPromise(s.getAll());
}

async function remove(id) {
  const s = await store(QUEUE_STORE, 'readwrite');
  await reqToPromise(s.delete(id));
}

async function update(entry) {
  const s = await store(QUEUE_STORE, 'readwrite');
  await reqToPromise(s.put(entry));
}

async function moveToFailed(entry, error) {
  const s = await store(FAILED_STORE, 'readwrite');
  await reqToPromise(s.put({ ...entry, error: String(error) }));
  await remove(entry.id);
}

/* Returns true once this entry is resolved (sent, converted-and-retried, or
   permanently failed) so flush() may continue to the next one; false to stop
   the whole flush here (network down / 5xx) — order must be preserved, so a
   later entry must never be sent ahead of an earlier one still stuck. */
async function sendOne(entry) {
  let res;
  try {
    res = await fetch(entry.url, {
      // (Phase 11) auth rides along as the session cookie automatically —
      // this is same-origin, so no Authorization header to attach by hand
      // — but a queued write is still a mutating request and needs the
      // CSRF header just like every other POST/PATCH/DELETE.
      method: entry.method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': API.csrfToken, 'Idempotency-Key': entry.key },
      body: JSON.stringify(entry.body),
    });
  } catch (e) {
    entry.attempts++;
    await update(entry);
    return false;
  }

  if (res.ok) { await remove(entry.id); return true; }

  if (res.status === 409 && !entry.converted && entry.method === 'POST' && entry.url === '/api/orders') {
    // one_open_order_per_table (phase 03): another device created the order
    // for this table while we were offline. Convert the queued create into an
    // append to that order and retry once — never twice, so a genuinely bad
    // append doesn't loop forever pretending to be a fresh conversion.
    const data = await res.json().catch(() => ({}));
    if (data.order_id) {
      entry.url = `/api/orders/${data.order_id}/items`;
      entry.body = { items: entry.body.items };
      entry.key = uuid();
      entry.converted = true;
      await update(entry);
      return sendOne(entry);
    }
  }

  if (res.status >= 500) {
    entry.attempts++;
    await update(entry);
    return false;
  }

  // 4xx other than a convertible 409: retrying forever would be worse than a
  // visible error — move it out of the queue and surface it.
  await moveToFailed(entry, `HTTP ${res.status}`);
  return true;
}

let flushing = false;
export async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const entries = (await pending()).sort((a, b) => a.createdAt - b.createdAt);
    for (const entry of entries) {
      const resolved = await sendOne(entry);
      if (!resolved) break; // preserve order: stop here, the rest wait for the next trigger
    }
  } finally {
    flushing = false;
    notify();
  }
}

// Flush on app start, on 'online', and every 15s while entries remain.
export function startOutbox() {
  flush();
  window.addEventListener('online', flush);
  setInterval(() => { pending().then(entries => { if (entries.length) flush(); }); }, 15000);
}
