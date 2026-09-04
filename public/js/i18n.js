// Bilingual (BM/EN) UI chrome — phase 10. Menu item names are entered by the
// restaurant and must render exactly as typed; nothing here ever touches
// them, only the app's own labels/buttons/headings.
const STORAGE_KEY = 'pos_locale';

const translations = {
  'common.logout': { en: 'Log Out', ms: 'Log Keluar' },
  'common.changePin': { en: 'Change my PIN', ms: 'Tukar PIN Saya' },
  'nav.pos': { en: 'Orders', ms: 'Pesanan' },
  'nav.kitchen': { en: 'Kitchen', ms: 'Dapur' },
  'nav.dashboard': { en: 'Dashboard', ms: 'Papan Pemuka' },
  'nav.shift': { en: 'Shift', ms: 'Syif' },
  'nav.admin': { en: 'Admin', ms: 'Admin' },

  'login.subtitle': { en: 'Staff & Admin Login', ms: 'Log Masuk Staf & Admin' },
  'login.name': { en: 'Name', ms: 'Nama' },
  'login.pin': { en: 'PIN', ms: 'PIN' },
  'login.submit': { en: 'Log In', ms: 'Log Masuk' },

  'pos.backToTables': { en: 'Back to Tables', ms: 'Kembali ke Meja' },
  'pos.categories': { en: 'Categories', ms: 'Kategori' },
  'pos.search': { en: 'Search items…', ms: 'Cari item…' },
  'pos.currentOrder': { en: 'Current Order', ms: 'Pesanan Semasa' },
  'pos.noItems': { en: 'No items yet', ms: 'Belum ada item' },
  'pos.subtotal': { en: 'Subtotal', ms: 'Jumlah Kecil' },
  'pos.serviceCharge': { en: 'Service charge', ms: 'Caj Perkhidmatan' },
  'pos.sst': { en: 'SST', ms: 'SST' },
  'pos.total': { en: 'Total', ms: 'Jumlah' },
  'pos.sendToKitchen': { en: 'Send to Kitchen', ms: 'Hantar ke Dapur' },
  'pos.markPaid': { en: 'Mark Paid', ms: 'Tandakan Dibayar' },

  'kitchen.heading': { en: 'Kitchen Orders', ms: 'Pesanan Dapur' },
  'kitchen.served': { en: ' Served (Waiting for Payment)', ms: ' Dihidang (Menunggu Bayaran)' },

  'dashboard.heading': { en: 'Sales Dashboard', ms: 'Papan Pemuka Jualan' },
  'dashboard.topItems': { en: 'Top Items Today', ms: 'Item Terlaris Hari Ini' },

  'customer.subtitle': { en: 'Scan & Order · No app needed', ms: 'Imbas & Pesan · Tiada aplikasi diperlukan' },
  'customer.viewOrder': { en: 'View Order', ms: 'Lihat Pesanan' },
  'customer.yourOrder': { en: 'Your Order', ms: 'Pesanan Anda' },
  'customer.keepBrowsing': { en: 'Keep Browsing', ms: 'Teruskan Melayari' },
  'customer.placeOrder': { en: 'Place Order', ms: 'Buat Pesanan' },
  'customer.orderPlaced': { en: 'Order Placed!', ms: 'Pesanan Dihantar!' },
  'customer.orderMore': { en: 'Order More', ms: 'Pesan Lagi' },
};

function currentLocale() {
  try { return localStorage.getItem(STORAGE_KEY) || 'en'; } catch { return 'en'; }
}

// Exported for any dynamically-generated string (e.g. nav.js's tab labels)
// that can't carry a data-i18n attribute in static markup.
export function t(key) {
  const entry = translations[key];
  if (!entry) return key;
  return entry[currentLocale()] || entry.en;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  const toggle = document.getElementById('locale-toggle');
  if (toggle) toggle.textContent = currentLocale() === 'ms' ? 'BM' : 'EN';
  document.documentElement.lang = currentLocale();
}

export function setLocale(loc) {
  try { localStorage.setItem(STORAGE_KEY, loc); } catch { /* private browsing, etc. */ }
  applyI18n();
  // nav.js's tab labels are built once (JS strings, not static markup) and
  // need their own hook to re-label in place without resetting whichever
  // tab is active, so a plain DOM event decouples it from this module.
  document.dispatchEvent(new Event('localechange'));
}

function toggleLocale() { setLocale(currentLocale() === 'en' ? 'ms' : 'en'); }

// Persisted per device (localStorage), applied on every load without waiting
// for a click.
applyI18n();

document.addEventListener('click', e => {
  if (e.target.closest('[data-action="toggle-locale"]')) toggleLocale();
});
