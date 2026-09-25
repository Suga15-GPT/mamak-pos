/* ===== FEATURE MODULES (client side) =====
   What the shop has switched on, from GET /api/features. The server refuses a
   switched-off module outright (404 feature_disabled); this only keeps the
   screens from offering it.

   Most hiding is declarative: anything a module owns carries
   data-feature="<module>", and a switched-off module puts
   `feat-off-<module>` on <body>, which style.css turns into display:none. So a
   control drawn later by any renderer is hidden without that renderer knowing
   about features at all. */

export const MODULES = ['kitchen', 'stations', 'printing', 'shifts', 'discounts', 'refunds', 'split_combine', 'qr', 'voice', 'dashboard'];
export const PARENT = { stations: 'kitchen', voice: 'qr' };
export const PRESETS = {
  lite: [],
  medium: ['kitchen', 'printing', 'shifts', 'discounts', 'split_combine'],
  advanced: MODULES,
};

// Everything on until told otherwise — the same default the server uses, so a
// failed fetch hides nothing rather than hiding everything.
const state = { flags: Object.fromEntries(MODULES.map(m => [m, true])), setupCompleted: true };

export const on = name => state.flags[name] !== false;
export const setupCompleted = () => state.setupCompleted;
export const flags = () => ({ ...state.flags });

export function applyFlags(next, setupDone = state.setupCompleted) {
  state.flags = { ...state.flags, ...next };
  state.setupCompleted = setupDone;
  MODULES.forEach(m => document.body.classList.toggle(`feat-off-${m}`, !on(m)));
}

export async function loadFeatures() {
  try {
    const r = await API.get('/api/features');
    applyFlags(r.features, r.setup_completed);
  } catch (e) { console.error('features load failed', e); }
  return state;
}

// "{n} cards" -> "50 cards". i18n.js's t() has no placeholders of its own.
export function fill(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}
