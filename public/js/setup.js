import { $, esc, toast } from './state.js';
import { t } from './i18n.js';
import { MODULES, PARENT, PRESETS, flags, applyFlags, fill } from './features.js';

/* ===== SETUP WIZARD + FEATURES SCREEN =====
   The wizard is shown to an admin at login until setup is finished, and can't
   be dismissed on a fresh install; Admin -> Features & setup reopens it any
   time. The Features screen is the same list of modules, saved one switch at a
   time. Both speak to a shop owner — "Kitchen screen", never "KDS". */

const name = m => t(`module.${m}`);

/* Turning a module off turns off anything that needs it; turning it on leaves
   those alone — the same rule the server applies. Returns the children that
   went off with it, so the screen can say so. */
function toggle(f, mod, value) {
  f[mod] = value;
  const switchedOff = [];
  if (!value) {
    for (const [child, parent] of Object.entries(PARENT)) {
      if (parent === mod && f[child]) { f[child] = false; switchedOff.push(child); }
    }
  }
  return switchedOff;
}

function childNotice(children) {
  return children.map(c => fill(t('features.childOff'), { child: name(c), parent: name(PARENT[c]) })).join(' ');
}

// One row per optional module: the plain-English name, one line saying what
// it does in the shop, and a switch. A module that needs another sits under it
// and can't be switched on while its parent is off. `note` ({module, text})
// puts "X was switched off too" under the switch that did it, where the owner
// is looking, rather than at the top of a list they have scrolled past.
function moduleRows(f, note = null) {
  return MODULES.map(m => {
    const parent = PARENT[m];
    const blocked = parent && !f[parent];
    return `<div class="admin-row feature-row${parent ? ' child' : ''}">
      <div>
        <b>${esc(name(m))}</b>
        <div class="meta">${esc(t(`module.${m}.desc`))}</div>
        ${parent ? `<div class="meta feature-needs">${esc(fill(t('features.needs'), { parent: name(parent) }))}</div>` : ''}
        ${note && note.module === m && note.text ? `<div class="banner info feature-note" role="status">${esc(note.text)}</div>` : ''}
      </div>
      <label class="switch" title="${esc(name(m))}">
        <input type="checkbox" data-action="toggle-module" data-module="${m}" aria-label="${esc(name(m))}"
          ${f[m] ? 'checked' : ''} ${blocked ? 'disabled' : ''}><span class="slider"></span>
      </label>
    </div>`;
  }).join('');
}

/* ===== the wizard ===== */

let draft = null;
let steps = [];
let stepIdx = 0;
let mandatory = false;
let onDone = null;
let notice = null;   // {module, text} — see moduleRows()

function computeSteps() {
  steps = ['shop', 'preset', 'modules', 'cards', ...(draft.features.qr ? ['qr'] : []), 'review'];
}

function presetMatching(f) {
  return Object.keys(PRESETS).find(p => MODULES.every(m => !!f[m] === PRESETS[p].includes(m))) || null;
}

export async function openSetup(opts = {}) {
  mandatory = !!opts.mandatory;
  onDone = opts.onDone || null;
  const [settings, cards] = await Promise.all([
    API.get('/api/settings').catch(() => ({})),
    API.get('/api/admin/cards').catch(() => []),
  ]);
  const current = flags();
  draft = {
    restaurant_name: settings.restaurant_name || '',
    restaurant_address: settings.restaurant_address || '',
    sst_number: settings.sst_number || '',
    tax: ((settings.tax_rate_bp ?? 600) / 100).toString(),
    svc: ((settings.svc_rate_bp ?? 0) / 100).toString(),
    // A fresh install picks a starting point; a re-run starts from what the
    // shop has now, and names the preset only if it still matches one.
    preset: mandatory ? null : presetMatching(current),
    features: current,
    card_count: String(cards.length || 50),
    qr_mode: settings.qr_mode === 'shop' ? 'shop' : 'per_card',
  };
  stepIdx = 0;
  notice = null;
  computeSteps();
  render();
  $('setup-modal').classList.add('show');
}

function close() { $('setup-modal').classList.remove('show'); }

// Every input names its type: the shared input styles key on it.
function field(id, label, value, attrs = 'type="text"') {
  return `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" value="${esc(value)}" ${attrs}></div>`;
}

function choice(group, value, title, desc, checked) {
  return `<label class="setup-choice">
    <input type="radio" name="${group}" value="${value}" ${checked ? 'checked' : ''}>
    <span><b>${esc(title)}</b><span class="meta">${esc(desc)}</span></span>
  </label>`;
}

const STEP_TITLE = {
  shop: 'setup.shop.title', preset: 'setup.preset.title', modules: 'setup.modules.title',
  cards: 'setup.cards.title', qr: 'setup.qr.title', review: 'setup.review.title',
};

function stepBody(step) {
  const d = draft;
  if (step === 'shop') {
    return `<p class="meta setup-hint">${esc(t('setup.shop.hint'))}</p>
      ${field('setup-name', t('setup.shop.name'), d.restaurant_name, 'type="text" autocomplete="organization"')}
      ${field('setup-address', t('setup.shop.address'), d.restaurant_address)}
      ${field('setup-sst', t('setup.shop.sst'), d.sst_number)}
      <div class="form-grid">
        ${field('setup-tax', t('setup.shop.tax'), d.tax, 'type="number" min="0" max="100" step="0.01" inputmode="decimal"')}
        ${field('setup-svc', t('setup.shop.svc'), d.svc, 'type="number" min="0" max="100" step="0.01" inputmode="decimal"')}
      </div>`;
  }
  if (step === 'preset') {
    return `<p class="meta setup-hint">${esc(t('setup.preset.hint'))}</p>
      <div class="setup-choices">
        ${['lite', 'medium', 'advanced'].map(p =>
          choice('setup-preset', p, t(`setup.preset.${p}`), t(`setup.preset.${p}.desc`), d.preset === p)).join('')}
      </div>`;
  }
  if (step === 'modules') {
    return `<p class="meta setup-hint">${esc(t('features.alwaysOn'))}</p>
      <div class="feature-list">${moduleRows(d.features, notice)}</div>`;
  }
  if (step === 'cards') {
    return `<p class="meta setup-hint">${esc(t('setup.cards.hint'))}</p>
      ${field('setup-cards', t('setup.cards.label'), d.card_count, 'type="number" min="1" max="999" step="1" inputmode="numeric"')}`;
  }
  if (step === 'qr') {
    return `<div class="setup-choices">
      ${choice('setup-qr', 'per_card', t('setup.qr.per_card'), t('setup.qr.per_card.desc'), d.qr_mode === 'per_card')}
      ${choice('setup-qr', 'shop', t('setup.qr.shop'), t('setup.qr.shop.desc'), d.qr_mode === 'shop')}
    </div>`;
  }
  // review
  const onList = MODULES.filter(m => d.features[m]);
  const offList = MODULES.filter(m => !d.features[m]);
  return `<div class="totals setup-review">
      <div class="row"><span>${esc(t('setup.shop.name'))}</span><span>${esc(d.restaurant_name)}</span></div>
      ${d.restaurant_address ? `<div class="row"><span>${esc(t('setup.shop.address'))}</span><span>${esc(d.restaurant_address)}</span></div>` : ''}
      <div class="row"><span>${esc(t('setup.review.taxLabel'))}</span><span>${esc(fill(t('setup.review.tax'), { tax: d.tax, svc: d.svc }))}</span></div>
      <div class="row"><span>${esc(t('setup.cards.label'))}</span><span>${esc(fill(t('setup.review.cards'), { n: d.card_count }))}</span></div>
      ${d.features.qr ? `<div class="row"><span>${esc(t('module.qr'))}</span><span>${esc(t(`setup.qr.${d.qr_mode}`))}</span></div>` : ''}
    </div>
    <div class="bill-group-head">${esc(t('setup.review.on'))}</div>
    <div class="chip-row">${onList.length
      ? onList.map(m => `<span class="chip sage">${esc(name(m))}</span>`).join('')
      : `<span class="meta">${esc(t('setup.review.none'))}</span>`}</div>
    ${offList.length ? `<div class="bill-group-head">${esc(t('setup.review.off'))}</div>
      <div class="chip-row">${offList.map(m => `<span class="chip">${esc(name(m))}</span>`).join('')}</div>` : ''}`;
}

function render() {
  const step = steps[stepIdx];
  $('setup-step').textContent = fill(t('setup.step'), { n: stepIdx + 1, total: steps.length });
  $('setup-title').textContent = t(STEP_TITLE[step]);
  $('setup-bar').style.width = `${((stepIdx + 1) / steps.length) * 100}%`;
  $('setup-body').innerHTML = stepBody(step);
  $('setup-err').textContent = '';
  $('setup-back').textContent = t('setup.back');
  $('setup-back').hidden = stepIdx === 0;
  $('setup-next').textContent = step === 'review' ? t('setup.finish') : t('setup.next');
  $('setup-next').disabled = false;
  $('setup-cancel').textContent = t('setup.cancel');
  $('setup-cancel').hidden = mandatory;
  const first = $('setup-body').querySelector('input');
  // Straight into the first box to type in; a list of choices waits for a tap.
  if (first && first.type !== 'radio' && first.type !== 'checkbox') first.focus();
}

// Reads the step's inputs into the draft; returns an error sentence or ''.
function collect(step) {
  const d = draft;
  if (step === 'shop') {
    d.restaurant_name = $('setup-name').value.trim();
    d.restaurant_address = $('setup-address').value.trim();
    d.sst_number = $('setup-sst').value.trim();
    d.tax = $('setup-tax').value.trim() || '0';
    d.svc = $('setup-svc').value.trim() || '0';
    if (!d.restaurant_name) return t('setup.shop.nameRequired');
    const bad = v => !(Number(v) >= 0 && Number(v) <= 100);
    if (bad(d.tax) || bad(d.svc)) return t('setup.shop.badRate');
  }
  if (step === 'preset' && !d.preset && mandatory) return t('setup.preset.required');
  if (step === 'cards') {
    d.card_count = $('setup-cards').value.trim();
    const n = Number(d.card_count);
    if (!Number.isInteger(n) || n < 1 || n > 999) return t('setup.cards.bad');
  }
  return '';
}

async function finish() {
  const d = draft;
  $('setup-next').disabled = true;
  $('setup-next').textContent = t('setup.saving');
  try {
    const r = await API.post('/api/setup', {
      restaurant_name: d.restaurant_name, restaurant_address: d.restaurant_address, sst_number: d.sst_number,
      tax_rate_bp: Math.round(Number(d.tax) * 100), svc_rate_bp: Math.round(Number(d.svc) * 100),
      card_count: Number(d.card_count), features: d.features,
      ...(d.features.qr ? { qr_mode: d.qr_mode } : {}),
    });
    applyFlags(r.features, true);
    close();
    toast(t('setup.done'));
    document.dispatchEvent(new Event('features-changed'));
    if (onDone) onDone();
  } catch (e) {
    $('setup-err').textContent = e.message;
    $('setup-next').disabled = false;
    $('setup-next').textContent = t('setup.finish');
  }
}

$('setup-modal').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'setup-cancel' && !mandatory) close();
  else if (a === 'setup-back' && stepIdx > 0) { collect(steps[stepIdx]); stepIdx--; notice = null; render(); }
  else if (a === 'setup-next') {
    const step = steps[stepIdx];
    const err = collect(step);
    if (err) { $('setup-err').textContent = err; return; }
    if (step === 'review') { finish(); return; }
    computeSteps();
    stepIdx = Math.min(stepIdx + 1, steps.length - 1);
    notice = null;
    render();
  }
});

$('setup-modal').addEventListener('change', e => {
  const el = e.target;
  if (el.name === 'setup-preset') {
    draft.preset = el.value;
    draft.features = Object.fromEntries(MODULES.map(m => [m, PRESETS[el.value].includes(m)]));
  } else if (el.name === 'setup-qr') {
    draft.qr_mode = el.value;
  } else if (el.dataset.action === 'toggle-module') {
    const mod = el.dataset.module;
    const off = toggle(draft.features, mod, el.checked);
    notice = { module: mod, text: childNotice(off) };
    // Only the module list changes; the step count may (QR adds a step).
    computeSteps();
    $('setup-step').textContent = fill(t('setup.step'), { n: stepIdx + 1, total: steps.length });
    $('setup-bar').style.width = `${((stepIdx + 1) / steps.length) * 100}%`;
    $('setup-body').innerHTML = stepBody('modules');
    $('setup-body').querySelector(`input[data-module="${mod}"]`)?.focus();
  }
});

/* ===== Admin -> Features & setup ===== */

export function renderFeaturesSection(note = null) {
  $('features-list').innerHTML = moduleRows(flags(), note);
  if (note) $('features-list').querySelector(`input[data-module="${note.module}"]`)?.focus();
}

async function saveModule(mod, value) {
  try {
    const r = await API.patch('/api/features', { features: { [mod]: value } });
    applyFlags(r.features);
    renderFeaturesSection({ module: mod, text: childNotice(r.switched_off) });
    toast(`${name(mod)} — ${t('features.saved')}`);
    document.dispatchEvent(new Event('features-changed'));
  } catch (e) {
    toast(e.message);
    renderFeaturesSection();
  }
}

$('sec-features').addEventListener('change', e => {
  const el = e.target.closest('[data-action="toggle-module"]');
  if (el) saveModule(el.dataset.module, el.checked);
});
$('sec-features').addEventListener('click', e => {
  if (e.target.closest('[data-action="run-setup"]')) openSetup({ mandatory: false, onDone: () => renderFeaturesSection() });
});

