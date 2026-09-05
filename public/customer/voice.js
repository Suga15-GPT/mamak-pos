import { $, fmt, esc, toast } from '../js/state.js';
import { t } from '../js/i18n.js';

/* ===== SPEAK TO ORDER (customer) =====
   Tap, talk, look at what came back, change anything, then confirm.

   This module records and shows. It decides nothing: it posts the audio, the
   server transcribes and interprets it, and everything rendered here — names,
   prices, the total — is what the POS handed back after validating against the
   live menu. When the customer confirms, `onConfirm` submits through the same
   path the Browse-menu basket uses. Until then no order exists anywhere.

   Deliberately not built: always-on listening. A mamak at 9pm is the noisiest
   room in Malaysia, and a microphone that never stops is both a battery bill and
   a privacy problem nobody asked for. Tap to speak, tap to stop. */

const MAX_SECONDS = 25;
// Ordered by preference: Opus in a WebM or Ogg container where the browser has
// it (small and clear), then whatever Safari will give us.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg',
  'audio/mp4', 'audio/mpeg',
];

let tableToken = null;
let onConfirm = null;      // (items) => Promise — the ordinary submit path
let onAddMore = null;      // (lines) => void   — hand the draft to the basket
let onBrowse = null;       // () => void

let recorder = null;
let mediaStream = null;
let audioCtx = null;
let analyser = null;
let meterRaf = null;
let stopTimer = null;
let tickTimer = null;
let startedAt = 0;
let cancelled = false;

let draft = [];            // the proposal, as the server priced it
let lastTranscript = '';
let menu = null;           // for the "choose an option" hand-off

export function initVoice(opts) {
  tableToken = opts.tableToken;
  onConfirm = opts.onConfirm;
  onAddMore = opts.onAddMore;
  onBrowse = opts.onBrowse;
  menu = opts.menu;

  // No microphone on this device or this browser: show the menu and say nothing
  // about a feature the customer cannot use.
  if (!supported()) return false;
  $('voice-hero').hidden = false;
  if ($('success-voice-btn')) $('success-voice-btn').hidden = false;
  return true;
}

function supported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    && window.MediaRecorder && window.isSecureContext);
}

function pickMime() {
  for (const m of MIME_CANDIDATES) {
    if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

/* ---------- the sheet ---------- */

const STATES = ['listening', 'working', 'error', 'review'];
function showState(name) {
  STATES.forEach(s => { $('vs-' + s).hidden = s !== name; });
  $('voice-modal').classList.add('show');
}
function closeSheet() { $('voice-modal').classList.remove('show'); }

function showError(message, title) {
  $('vs-error-title').textContent = title || 'Sorry, I could not hear that';
  $('vs-error-msg').textContent = message;
  showState('error');
}

/* ---------- recording ---------- */

export async function startListening() {
  if (recorder) return;
  cancelled = false;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    // Denied, dismissed, or no microphone at all — all the same to the customer.
    return showError(
      'We could not use the microphone. You can allow it in your browser settings, or just browse the menu.',
      'Microphone not available');
  }

  const mimeType = pickMime();
  try {
    recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : {});
  } catch (e) {
    stopStream();
    return showError('This browser will not let us record. Please browse the menu instead.', 'Cannot record here');
  }

  const chunks = [];
  recorder.ondataavailable = ev => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  recorder.onstop = async () => {
    stopMeter();
    stopStream();
    const type = (recorder && recorder.mimeType) || mimeType || 'audio/webm';
    recorder = null;
    if (cancelled) { closeSheet(); return; }
    const blob = new Blob(chunks, { type });
    // Under ~1.5kB is a tap, not a sentence.
    if (blob.size < 1500) {
      return showError('That was too short — hold on and say your order after tapping.', 'I did not catch that');
    }
    await send(blob, type.split(';')[0]);
  };

  recorder.start();
  startedAt = Date.now();
  showState('listening');
  startMeter();
  tick();
  tickTimer = setInterval(tick, 250);
  // A hard ceiling: an order is ten seconds, and a phone left face-down on the
  // table should not quietly upload half a minute of a stranger's conversation.
  stopTimer = setTimeout(() => stopListening(), MAX_SECONDS * 1000);
}

function tick() {
  const left = Math.max(0, MAX_SECONDS - Math.floor((Date.now() - startedAt) / 1000));
  $('voice-timer').textContent = left <= 8 ? `${left}s left` : '';
}

export function stopListening() {
  clearTimeout(stopTimer);
  clearInterval(tickTimer);
  if (recorder && recorder.state !== 'inactive') { showState('working'); recorder.stop(); }
}

export function cancelListening() {
  cancelled = true;
  clearTimeout(stopTimer);
  clearInterval(tickTimer);
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  else { stopMeter(); stopStream(); closeSheet(); }
}

function stopStream() {
  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  mediaStream = null;
}

/* The meter is wired to the real input level. It is the only honest way to
   answer "is this thing hearing me?" across a room this loud. */
function startMeter() {
  const bars = [...$('voice-meter').children];
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    audioCtx.createMediaStreamSource(mediaStream).connect(analyser);
  } catch { analyser = null; }
  if (!analyser) { bars.forEach(b => { b.style.height = '20px'; }); return; }

  const data = new Uint8Array(analyser.frequencyBinCount);
  const draw = () => {
    analyser.getByteFrequencyData(data);
    bars.forEach((bar, i) => {
      const v = data[Math.min(data.length - 1, i * 2 + 1)] / 255;
      bar.style.height = `${Math.max(8, Math.round(v * 68))}px`;
    });
    meterRaf = requestAnimationFrame(draw);
  };
  draw();
}

function stopMeter() {
  if (meterRaf) cancelAnimationFrame(meterRaf);
  meterRaf = null;
  analyser = null;
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
}

/* ---------- the round trip ---------- */

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Chunked: btoa on a single 700kB string blows the argument limit on older
  // mobile Safari.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function send(blob, mimeType) {
  showState('working');
  try {
    const res = await fetch('/api/public/voice/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table_token: tableToken,
        mime_type: mimeType,
        audio_base64: await blobToBase64(blob),
        // Sending the current proposal back is what makes "make the teh tarik
        // two" work. It is context only — the server re-prices every line from
        // its own database no matter what arrives here.
        draft: draft.map(l => ({ item_id: l.item_id, name: l.name, qty: l.qty, note: l.note, mods: l.mods })),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return showError(body.message || 'Please try again, or browse the menu.');

    lastTranscript = body.transcript || '';
    if (!body.understood || !body.lines.length) {
      const heard = lastTranscript ? `I heard: “${lastTranscript}”. ` : '';
      return showError(`${heard}Please try again, or browse the menu and tap what you want.`);
    }
    draft = body.lines;
    renderReview(body);
  } catch (e) {
    showError('Your connection dropped. Please try again.');
  }
}

/* ---------- the review ---------- */

const REJECTION_WORDS = {
  sold_out: name => `${name} is finished for today.`,
  unavailable: name => `${name} is not on the menu right now.`,
  unknown: () => 'One thing I heard is not on the menu.',
};

function renderReview(body) {
  $('vs-heard').textContent = lastTranscript ? `You said: “${lastTranscript}”` : '';

  const clarify = $('vs-clarify');
  clarify.hidden = !body.clarification;
  if (body.clarification) clarify.textContent = body.clarification;

  const rej = $('vs-rejected');
  const notes = (body.rejected || []).map(r => (REJECTION_WORDS[r.reason] || REJECTION_WORDS.unknown)(r.name));
  rej.hidden = !notes.length;
  if (notes.length) rej.textContent = notes.join(' ');

  renderLines();
  showState('review');
}

function renderLines() {
  $('vs-lines').innerHTML = draft.map((l, i) => {
    const mods = l.mods.map(m => m.name + (m.price ? ` +${fmt(m.price)}` : '')).join(', ');
    const sub = [mods, l.note ? `📝 ${l.note}` : ''].filter(Boolean).map(esc).join(' · ');
    const needs = (l.needs_choice || []).length
      ? `<div class="v-needs"><button class="btn small outline" data-action="voice-choose" data-idx="${i}">
           Choose ${esc(l.needs_choice.join(' and '))}</button></div>`
      : '';
    return `<div class="v-line">
      <div class="v-top">
        <span class="v-name">${l.qty}× ${esc(l.name)}</span>
        <span class="v-price">${fmt(l.line_total)}</span>
      </div>
      ${sub ? `<div class="v-sub">${sub}</div>` : ''}
      ${needs}
      <div class="v-actions">
        <div class="qty">
          <button data-action="voice-qty" data-idx="${i}" data-delta="-1" aria-label="One fewer ${esc(l.name)}">−</button>
          <button data-action="voice-qty" data-idx="${i}" data-delta="1" aria-label="One more ${esc(l.name)}">+</button>
        </div>
        <button class="v-del" data-action="voice-remove" data-idx="${i}">Remove</button>
      </div>
    </div>`;
  }).join('');

  const total = draft.reduce((s, l) => s + Math.round(l.line_total * 100), 0) / 100;
  $('vs-total').textContent = fmt(total);

  // A line that still owes the kitchen an answer blocks the whole order — the
  // cook cannot start a nasi kandar without knowing which kuah.
  const blocked = draft.some(l => (l.needs_choice || []).length);
  const btn = $('vs-confirm');
  btn.disabled = blocked || !draft.length;
  btn.textContent = t(blocked ? 'voice.blocked' : 'voice.confirm');
}

function changeQty(i, delta) {
  const line = draft[i];
  if (!line) return;
  line.qty = Math.min(20, line.qty + delta);
  if (line.qty < 1) return removeLine(i);
  // Priced off the server's own unit price for this line — never recomputed
  // from anything the model said.
  line.line_total = Math.round(line.unit_price * line.qty * 100) / 100;
  renderLines();
}

function removeLine(i) {
  draft.splice(i, 1);
  if (!draft.length) return showError('Your order is empty now. Say it again, or browse the menu.', 'Nothing left');
  renderLines();
}

/* A line the kitchen still has a question about is handed to the existing
   food-options dialog rather than answered by guessing. */
let chooseIdx = null;
export function chooseFor(i) {
  const line = draft[i];
  if (!line || !menu) return;
  const item = menu.items.find(it => it.id === line.item_id);
  if (!item) return;
  chooseIdx = i;
  closeSheet();
  document.dispatchEvent(new CustomEvent('voice-needs-options', { detail: { item } }));
}

/* customer.js calls this back once the dialog has been answered. */
export function applyChoice(mods) {
  if (chooseIdx == null) return;
  const line = draft[chooseIdx];
  chooseIdx = null;
  if (!line) return;
  line.mods = mods.map(m => ({ id: m.id, name: m.name, price: m.price }));
  line.needs_choice = [];
  const unit = line.unit_price_base != null ? line.unit_price_base : line.unit_price;
  line.unit_price_base = unit;
  line.unit_price = Math.round((unit + mods.reduce((s, m) => s + m.price, 0)) * 100) / 100;
  line.line_total = Math.round(line.unit_price * line.qty * 100) / 100;
  renderLines();
  showState('review');
}

export function reopenReview() {
  if (draft.length) { renderLines(); showState('review'); }
}

/* ---------- leaving ---------- */

async function confirm() {
  const btn = $('vs-confirm');
  btn.disabled = true;
  btn.textContent = t('voice.sending');
  try {
    await onConfirm(draft.map(l => ({
      item_id: l.item_id,
      qty: l.qty,
      note: l.note,
      modifier_option_ids: l.mods.map(m => m.id).filter(id => Number.isInteger(id)),
    })));
    draft = [];
    closeSheet();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = t('voice.confirm');
    toast(e.message || 'Could not send your order. Please try again or ask our staff.');
  }
}

function addMore() {
  onAddMore(draft.slice());
  draft = [];
  closeSheet();
}

/* Walking away is a first-class outcome: the draft is dropped and nothing was
   ever created. */
function abandon() {
  draft = [];
  closeSheet();
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  // The listener is registered at load; initVoice() is what decides this
  // restaurant has voice at all. Until then nothing here is live.
  if (!tableToken) return;
  const a = el.dataset.action;
  if (a === 'voice-start') startListening();
  else if (a === 'voice-stop') stopListening();
  else if (a === 'voice-cancel') cancelListening();
  else if (a === 'voice-close') abandon();
  else if (a === 'voice-again') startListening();
  else if (a === 'voice-confirm') confirm();
  else if (a === 'voice-add-more') addMore();
  else if (a === 'voice-browse') { abandon(); onBrowse(); }
  else if (a === 'browse-menu') onBrowse();
  else if (a === 'voice-qty') changeQty(Number(el.dataset.idx), Number(el.dataset.delta));
  else if (a === 'voice-remove') removeLine(Number(el.dataset.idx));
  else if (a === 'voice-choose') chooseFor(Number(el.dataset.idx));
});

// Tapping the backdrop mid-recording stops the microphone rather than leaving
// it running behind a closed dialog.
$('voice-modal').addEventListener('click', e => {
  if (e.target !== $('voice-modal')) return;
  if (recorder) cancelListening(); else abandon();
});
