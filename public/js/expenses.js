import { $, fmt, esc, toast, ask } from './state.js';
import { on } from './features.js';

/* ===== EXPENSES (owner only) =====
   Add what the shop spent three ways: a photo of the receipt, a voice note,
   or typing. A photo or a voice note comes back as a filled-in form — nothing
   is saved until the owner checks it and presses Save. Regular costs (rent,
   wages) appear under "Due now" when they fall due, to be confirmed. */

let meta = null;
let draft = { source: 'manual', receipt_id: null, items: [] };
let previewUrl = null;
let recorder = null, recChunks = [], recTimer = null, recStart = 0, recCancelled = false;
const MAX_REC_SECONDS = 60;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const rm = c => fmt(c / 100);
const catName = id => meta?.categories.find(c => c.id === id)?.name || '';
const fmtDate = d => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };

function fillSelects() {
  const cats = meta.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  const methods = meta.methods.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  $('exp-category').innerHTML = cats;
  $('rec-category').innerHTML = cats;
  $('exp-method').innerHTML = methods;
  $('rec-method').innerHTML = methods;
  $('rec-method').value = 'Bank transfer';
  fillRecDays();
}
function fillRecDays() {
  const week = $('rec-every').value === 'week';
  $('rec-day').innerHTML = week
    ? WEEKDAYS.map((d, i) => `<option value="${i + 1}">${d}</option>`).join('')
    : Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}${i === 30 ? ' (or the last day)' : ''}</option>`).join('');
}

export async function refreshExpenses() {
  if (!on('expenses') || API.user?.role !== 'admin') return;
  try {
    meta = await API.get('/api/expenses/meta');
  } catch (e) { toast('Could not load expenses: ' + e.message); return; }
  fillSelects();
  $('exp-ai-off').hidden = meta.ai_enabled;
  $('exp-photo-btn').classList.toggle('disabled', !meta.ai_enabled);
  $('exp-voice-btn').disabled = !meta.ai_enabled || !window.MediaRecorder;
  if (!$('exp-month').value) $('exp-month').value = meta.today.slice(0, 7);
  renderRecent();
  renderDue();
  renderRecurring();
  await loadMonth();
}

/* ===== the form ===== */

function openForm(values = {}, { source = 'manual', receiptId = null, previewBlob = null, items = [] } = {}) {
  draft = { source, receipt_id: receiptId, items };
  $('exp-form').hidden = false;
  $('exp-date').value = values.spent_on || meta.today;
  $('exp-amount').value = values.amount != null ? Number(values.amount).toFixed(2) : '';
  $('exp-supplier').value = values.supplier || '';
  $('exp-category').value = values.category_id != null ? String(values.category_id) : String(meta.categories.find(c => c.name === 'Other')?.id || '');
  $('exp-method').value = values.method || 'Cash';
  $('exp-desc').value = values.description || '';
  $('exp-form-err').textContent = '';
  $('exp-draft-note').hidden = source === 'manual';
  $('exp-draft-note').textContent = `Filled in from your ${source === 'photo' ? 'photo' : 'voice note'}. Check every figure before you save — it can misread.`;
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  if (previewBlob) { previewUrl = URL.createObjectURL(previewBlob); $('exp-receipt-preview').src = previewUrl; }
  $('exp-receipt-preview').hidden = !previewBlob;
  $('exp-items').innerHTML = items.length
    ? `<div class="bill-group-head">On the receipt</div>${items.map(i => `<div class="cart-line"><div class="line-sub">${i.qty ? `${i.qty}× ` : ''}${esc(i.name)}</div>
        <div class="line-right">${i.amount != null ? fmt(i.amount) : ''}</div></div>`).join('')}`
    : '';
  // Anything the reader could not make out is left empty — start there.
  const firstEmpty = ['exp-amount', 'exp-supplier'].find(id => !$(id).value);
  $(firstEmpty || 'exp-amount').focus();
}
function closeForm() {
  $('exp-form').hidden = true;
  draft = { source: 'manual', receipt_id: null, items: [] };
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
}

async function saveForm(e) {
  e.preventDefault();
  const body = {
    spent_on: $('exp-date').value,
    amount: $('exp-amount').value,
    supplier: $('exp-supplier').value,
    category_id: $('exp-category').value,
    method: $('exp-method').value,
    description: $('exp-desc').value,
    items: draft.items,
    source: draft.source,
    receipt_id: draft.receipt_id,
  };
  $('exp-save').disabled = true;
  try {
    await API.post('/api/expenses', body);
    toast(`Saved — ${fmt(Number(body.amount))}`);
    closeForm();
    $('exp-month').value = body.spent_on.slice(0, 7);
    refreshExpenses();
  } catch (err) { $('exp-form-err').textContent = err.message; }
  finally { $('exp-save').disabled = false; }
}

/* ===== reading a photo or a voice note ===== */

// A phone photo is several MB; a receipt reads fine at 1600px. Downscaled
// here, so the upload is small and the kept copy doesn't bloat the backups.
function downscale(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => (b ? resolve(b) : reject(new Error('could not read the photo'))), 'image/jpeg', 0.78);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a photo')); };
    img.src = url;
  });
}
const toBase64 = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^;]+;base64,/, ''));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function readUpload(kind, blob, mime) {
  $('exp-reading').hidden = false;
  closeForm();
  try {
    const payload = { [kind]: { mime, data: await toBase64(blob) } };
    const r = await API.post('/api/expenses/extract', payload);
    openForm(r.draft, { source: r.source, receiptId: r.receipt_id, previewBlob: kind === 'image' ? blob : null, items: r.draft.items || [] });
  } catch (e) {
    toast(e.message);
    openForm({}, { source: 'manual' });
  } finally { $('exp-reading').hidden = true; }
}

async function onPhoto(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try { await readUpload('image', await downscale(file), 'image/jpeg'); }
  catch (err) { toast(err.message); }
}

async function startVoice() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('This phone cannot record here — type it in instead');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast('Allow the microphone to record a voice note'); }
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported?.(t)) || '';
  recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  recChunks = [];
  recCancelled = false;
  recorder.ondataavailable = ev => { if (ev.data.size) recChunks.push(ev.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(recTimer);
    $('exp-recording').hidden = true;
    if (recCancelled || !recChunks.length) return;
    const mime = (recorder.mimeType || type || 'audio/webm').split(';')[0];
    await readUpload('audio', new Blob(recChunks, { type: mime }), mime);
  };
  recorder.start();
  recStart = Date.now();
  $('exp-recording').hidden = false;
  $('exp-rec-time').textContent = '0:00';
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $('exp-rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= MAX_REC_SECONDS) recorder?.state === 'recording' && recorder.stop();
  }, 250);
}
function stopVoice(cancel) {
  recCancelled = !!cancel;
  if (recorder?.state === 'recording') recorder.stop();
}

/* ===== quick repeat, due now, regular costs ===== */

function renderRecent() {
  const list = meta.recent || [];
  $('exp-recent').innerHTML = list.length
    ? `<div class="label" style="margin-top:12px">Buy it again</div><div class="exp-chips">${list.map((r, i) => `
        <button class="chip" data-action="exp-repeat" data-idx="${i}">${esc(r.supplier || r.description || catName(r.category_id) || 'Purchase')} · ${fmt(r.amount)}</button>`).join('')}</div>`
    : '';
}

function renderDue() {
  const due = meta.due || [];
  $('exp-due-card').hidden = !due.length;
  $('exp-due').innerHTML = due.map(d => `
    <div class="exp-due-row">
      <div><b>${esc(d.name)}</b><div class="meta">Due ${esc(fmtDate(d.due_for))}${d.more ? ` · ${d.more} more after this` : ''}${d.category ? ` · ${esc(d.category)}` : ''}</div></div>
      <div class="exp-due-actions">
        <label class="sr-only" for="due-amt-${d.id}">Amount for ${esc(d.name)}</label>
        <input type="number" id="due-amt-${d.id}" min="0.01" step="0.01" value="${d.amount.toFixed(2)}">
        <button class="btn small" data-action="exp-due-record" data-id="${d.id}" data-for="${esc(d.due_for)}">Record</button>
        <button class="btn small ghost" data-action="exp-due-skip" data-id="${d.id}" data-for="${esc(d.due_for)}">Skip</button>
      </div>
    </div>`).join('');
}

function renderRecurring() {
  const list = meta.recurring || [];
  $('exp-recurring').innerHTML = list.length
    ? list.map(r => `<div class="exp-due-row${r.active ? '' : ' off'}">
        <div><b>${esc(r.name)}</b> · ${fmt(r.amount)}
          <div class="meta">Every ${r.every === 'week' ? WEEKDAYS[r.day - 1] : `month on day ${r.day}`}${r.category ? ` · ${esc(r.category)}` : ''} · ${esc(r.method)}${r.active ? '' : ' · switched off'}</div></div>
        <button class="btn small outline" data-action="exp-rec-toggle" data-id="${r.id}" data-active="${r.active}">${r.active ? 'Switch off' : 'Switch on'}</button>
      </div>`).join('')
    : '<div class="meta">None yet.</div>';
}

async function saveRecurring(e) {
  e.preventDefault();
  try {
    await API.post('/api/expenses/recurring', {
      name: $('rec-name').value, amount: $('rec-amount').value, category_id: $('rec-category').value,
      method: $('rec-method').value, every: $('rec-every').value, day: Number($('rec-day').value),
    });
    toast('Regular cost added');
    $('rec-name').value = ''; $('rec-amount').value = '';
    refreshExpenses();
  } catch (err) { toast(err.message); }
}

/* ===== the month's list ===== */

async function loadMonth() {
  let d;
  try { d = await API.get(`/api/expenses?month=${encodeURIComponent($('exp-month').value)}`); }
  catch (e) { $('exp-table').innerHTML = `<tr><td>${esc(e.message)}</td></tr>`; return; }
  $('exp-total').innerHTML = `Total <b>${rm(d.total_cents)}</b>`;
  const max = Math.max(1, ...d.by_category.map(c => c.cents));
  $('exp-by-cat').innerHTML = d.by_category.length
    ? `<div class="bar-list" style="margin-bottom:14px">${d.by_category.map(c => `
        <div class="bar-row"><span class="bar-name">${esc(c.name)}</span><span class="bar-val">${rm(c.cents)}</span>
          <span class="bar-track"><span class="bar-fill info" style="width:${((c.cents / max) * 100).toFixed(1)}%"></span></span></div>`).join('')}</div>`
    : '';
  $('exp-table').innerHTML = d.expenses.length
    ? `<thead><tr><th>Date</th><th>What</th><th>Category</th><th>Paid by</th><th class="num">Amount</th><th></th></tr></thead>
       <tbody>${d.expenses.map(x => `<tr class="${x.voided ? 'voided' : ''}">
         <td>${esc(fmtDate(x.spent_on))}</td>
         <td>${esc(x.supplier || '')}${x.supplier && x.description ? ' — ' : ''}${esc(x.description || '')}
           ${x.source !== 'manual' ? `<span class="chip">${x.source === 'photo' ? '📷' : x.source === 'voice' ? '🎙' : '🔁'}</span>` : ''}
           ${x.voided ? `<div class="meta">Voided: ${esc(x.void_reason || '')}</div>` : ''}</td>
         <td>${esc(x.category || '')}</td><td>${esc(x.method)}</td>
         <td class="num">${rm(x.amount_cents)}</td>
         <td class="exp-row-actions">${x.receipt_id ? `<button class="btn small ghost" data-action="exp-receipt" data-id="${x.receipt_id}" aria-label="See the receipt">📎</button>` : ''}
           ${x.voided ? '' : `<button class="btn small ghost" data-action="exp-void" data-id="${x.id}">Void</button>`}</td>
       </tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="meta">Nothing recorded this month yet.</td></tr></tbody>';
}

async function showReceipt(id) {
  try { window.open(await API.getBlobUrl(`/api/expenses/receipts/${id}`), '_blank', 'noopener'); }
  catch (e) { toast(e.message); }
}

/* ===== wiring ===== */

$('exp-photo-input').addEventListener('change', onPhoto);
$('exp-photo-btn').addEventListener('click', e => {
  if (meta && !meta.ai_enabled) { e.preventDefault(); toast('Reading receipts is not set up yet — type it in instead'); }
});
$('exp-form').addEventListener('submit', saveForm);
$('exp-rec-form').addEventListener('submit', saveRecurring);
$('rec-every').addEventListener('change', fillRecDays);
$('exp-month').addEventListener('change', loadMonth);
$('tab-expenses').addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const id = Number(el.dataset.id);
  if (a === 'exp-type') openForm({}, { source: 'manual' });
  else if (a === 'exp-cancel') closeForm();
  else if (a === 'exp-voice') startVoice();
  else if (a === 'exp-voice-stop') stopVoice(false);
  else if (a === 'exp-voice-cancel') stopVoice(true);
  else if (a === 'exp-repeat') {
    const r = meta.recent[Number(el.dataset.idx)];
    if (r) openForm({ ...r, spent_on: meta.today }, { source: 'manual' });
  } else if (a === 'exp-receipt') showReceipt(id);
  else if (a === 'exp-void') {
    const reason = await ask({ title: 'Void this expense?', hint: 'It stays in the list, crossed out. Why?', placeholder: 'e.g. entered twice', ok: 'Void' });
    if (reason == null) return;
    try { await API.post(`/api/expenses/${id}/void`, { reason }); toast('Voided'); refreshExpenses(); } catch (err) { toast(err.message); }
  } else if (a === 'exp-due-record' || a === 'exp-due-skip') {
    const skip = a === 'exp-due-skip';
    try {
      await API.post(`/api/expenses/recurring/${id}/${skip ? 'skip' : 'record'}`, { for: el.dataset.for, ...(skip ? {} : { amount: $(`due-amt-${id}`).value }) });
      toast(skip ? 'Skipped' : 'Recorded');
      refreshExpenses();
    } catch (err) { toast(err.message); }
  } else if (a === 'exp-rec-toggle') {
    try { await API.patch(`/api/expenses/recurring/${id}`, { active: el.dataset.active !== 'true' }); refreshExpenses(); } catch (err) { toast(err.message); }
  }
});
