// split.js — "Split the bill" on the customer's own phone.
//
// Works on the bill the card's QR already shows (GET /api/t/:token). Nothing
// here is sent anywhere: the names people type and who had what stay on this
// phone (sessionStorage), and the result is shared by WhatsApp or copied as
// text. Paying still happens at the counter; "Pay now" is shown, switched off,
// until a payment provider is connected.
//
// The arithmetic is in whole sen and always adds up to exactly what is left
// to pay: shares are proportional to what each person had, with the sen left
// over by rounding handed out one at a time (largest remainder first), so no
// share is ever a sen more or less than it should be by more than one.

import { $, fmt, esc, toast } from '../js/state.js';
import { splitEvenCents, splitByItems } from './split-math.js';

/* ===== The screen ===== */

let getBill = () => null;
let cardLabel = '';
let storeKey = 'mamak_split';
let mode = 'items';
let ways = 2;
let people = [];
let assigned = {};

function load() {
  try {
    const s = JSON.parse(sessionStorage.getItem(storeKey) || '{}');
    people = Array.isArray(s.people) ? s.people : [];
    assigned = s.assigned && typeof s.assigned === 'object' ? s.assigned : {};
    ways = Number(s.ways) >= 2 ? Number(s.ways) : 2;
    mode = s.mode === 'even' ? 'even' : 'items';
  } catch { /* private mode: start empty */ }
}
function save() {
  try { sessionStorage.setItem(storeKey, JSON.stringify({ people, assigned, ways, mode })); } catch { /* private mode */ }
}

const rm = c => fmt(c / 100);

function resultText() {
  const bill = getBill();
  if (!bill) return '';
  const head = `${cardLabel} — bill ${fmt(bill.total)}${bill.paid ? `, ${fmt(bill.paid)} already paid` : ''}`;
  if (mode === 'even') {
    const shares = splitEvenCents(Math.round(bill.due * 100), ways);
    return [head, `Split ${ways} ways:`, ...shares.map((c, i) => `Person ${i + 1}: ${rm(c)}`)].join('\n');
  }
  const r = splitByItems(bill, people, assigned);
  return [head, 'Split by what each person had:',
    ...r.people.map(p => `${p.name}: ${rm(p.cents)}${p.dishes.length ? ` (${p.dishes.join(', ')})` : ''}`),
    ...(r.unclaimed_cents ? [`Not yet claimed: ${rm(r.unclaimed_cents)}`] : [])].join('\n');
}

function render() {
  const bill = getBill();
  const body = $('split-body');
  if (!bill) { body.innerHTML = '<div class="empty">There is nothing on this card’s bill yet.</div>'; return; }
  document.querySelectorAll('#split-modal [data-split-mode]').forEach(b => {
    b.classList.toggle('on', b.dataset.splitMode === mode);
    b.setAttribute('aria-pressed', String(b.dataset.splitMode === mode));
  });
  const due = Math.round(bill.due * 100);
  const summary = `<div class="split-due">Left to pay <b>${fmt(bill.due)}</b>${bill.paid ? ` <span class="meta">(${fmt(bill.paid)} already paid)</span>` : ''}</div>`;

  if (mode === 'even') {
    const shares = splitEvenCents(due, ways);
    body.innerHTML = `${summary}
      <div class="split-ways">
        <span>How many people?</span>
        <button class="btn small outline" data-action="split-ways" data-delta="-1" aria-label="One person fewer">−</button>
        <b id="split-ways-n" aria-live="polite">${ways}</b>
        <button class="btn small outline" data-action="split-ways" data-delta="1" aria-label="One person more">＋</button>
      </div>
      <div class="split-results">${shares.map((c, i) => `<div class="split-row"><span>Person ${i + 1}</span><b>${rm(c)}</b></div>`).join('')}</div>`;
    return;
  }

  const r = splitByItems(bill, people, assigned);
  const open = bill.lines.filter(l => !l.paid && l.amount > 0);
  body.innerHTML = `${summary}
    <label class="label" for="split-name">Who is paying?</label>
    <div class="split-add">
      <input id="split-name" type="text" maxlength="20" placeholder="A name, e.g. Ali" autocomplete="off">
      <button class="btn small" data-action="split-add-person">Add</button>
    </div>
    <div class="split-people">${people.map(p => `<span class="chip on">${esc(p)}
      <button class="split-x" data-action="split-remove-person" data-name="${esc(p)}" aria-label="Remove ${esc(p)}">×</button></span>`).join('') || '<span class="meta">Add everyone who is paying, then tap who had each dish.</span>'}</div>
    ${people.length ? `<div class="split-lines">${open.map(l => `
      <div class="split-line">
        <div class="split-line-head"><span>${l.qty}× ${esc(l.name)}</span><span>${fmt(l.amount)}</span></div>
        <div class="split-who">${people.map(p => {
          const onIt = (assigned[l.id] || []).includes(p);
          return `<button class="chip${onIt ? ' on' : ''}" data-action="split-toggle" data-line="${l.id}" data-name="${esc(p)}" aria-pressed="${onIt}">${esc(p)}</button>`;
        }).join('')}</div>
      </div>`).join('')}</div>` : ''}
    ${people.length ? `<div class="split-results">
      ${r.people.map(p => `<div class="split-row"><span>${esc(p.name)}</span><b>${rm(p.cents)}</b></div>`).join('')}
      ${r.unclaimed_cents ? `<div class="split-row warn"><span>Not claimed yet</span><b>${rm(r.unclaimed_cents)}</b></div>` : ''}
    </div>
    <p class="meta">${esc(extrasSentence(bill))} A dish two people shared is split between them.</p>` : ''}`;
}

// "SST is shared…", "SST, the service charge and the discount are shared…"
function extrasSentence(bill) {
  const parts = [bill.tax ? 'SST' : null, bill.service_charge ? 'the service charge' : null, bill.discount ? 'the discount' : null].filter(Boolean);
  if (!parts.length) return '';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${list[0].toUpperCase()}${list.slice(1)} ${parts.length === 1 ? 'is' : 'are'} shared in the same proportion as the food.`;
}

function openSplit() {
  load();
  render();
  $('split-modal').classList.add('show');
}
function closeSplit() { $('split-modal').classList.remove('show'); }

function addPerson() {
  const input = $('split-name');
  const name = (input?.value || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  if (!name) return;
  if (people.some(p => p.toLowerCase() === name.toLowerCase())) { toast(`${name} is already on the list`); return; }
  if (people.length >= 20) { toast('Twenty people at most'); return; }
  people.push(name);
  save();
  render();
  $('split-name')?.focus();
}

// The bill refreshes every few seconds; don't redraw under someone typing a name.
export function refreshSplit() {
  if (!$('split-modal')?.classList.contains('show')) return;
  if (document.activeElement?.id === 'split-name' && document.activeElement.value) return;
  render();
}

let wired = false;
export function initSplit({ bill, label, token }) {
  getBill = bill;
  cardLabel = label;
  storeKey = `mamak_split_${token}`;
  // The page can start more than once (the shop poster asks for the card
  // number again); the buttons are wired only the first time.
  if (wired) return;
  wired = true;
  $('split-modal').addEventListener('click', e => {
    if (e.target === $('split-modal')) return closeSplit();
    const el = e.target.closest('[data-action], [data-split-mode]');
    if (!el) return;
    if (el.dataset.splitMode) { mode = el.dataset.splitMode; save(); render(); return; }
    const a = el.dataset.action;
    if (a === 'split-close') closeSplit();
    else if (a === 'split-ways') { ways = Math.min(30, Math.max(2, ways + Number(el.dataset.delta))); save(); render(); }
    else if (a === 'split-add-person') addPerson();
    else if (a === 'split-remove-person') {
      people = people.filter(p => p !== el.dataset.name);
      Object.keys(assigned).forEach(k => { assigned[k] = assigned[k].filter(p => p !== el.dataset.name); });
      save(); render();
    } else if (a === 'split-toggle') {
      const list = new Set(assigned[el.dataset.line] || []);
      if (list.has(el.dataset.name)) list.delete(el.dataset.name); else list.add(el.dataset.name);
      assigned[el.dataset.line] = [...list];
      save(); render();
    } else if (a === 'split-share') {
      window.open(`https://wa.me/?text=${encodeURIComponent(resultText())}`, '_blank', 'noopener');
    } else if (a === 'split-copy') {
      navigator.clipboard?.writeText(resultText()).then(() => toast('Copied'), () => toast('Could not copy on this phone'));
    }
  });
  $('split-modal').addEventListener('keydown', e => {
    if (e.target.id === 'split-name' && e.key === 'Enter') { e.preventDefault(); addPerson(); }
  });
  document.body.addEventListener('click', e => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (a === 'open-split') openSplit();
    else if (a === 'pay-now') toast('Paying on your phone is coming soon. Please pay at the counter for now.');
  });
}
