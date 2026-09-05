// Bilingual (BM/EN) UI chrome — phase 10. Menu item names are entered by the
// restaurant and must render exactly as typed; nothing here ever touches
// them, only the app's own labels/buttons/headings.
const STORAGE_KEY = 'pos_locale';

const translations = {
  'common.logout': { en: 'Log Out', ms: 'Log Keluar' },
  'common.refresh': { en: 'Refresh', ms: 'Muat Semula' },
  'common.changePin': { en: 'Change my PIN', ms: 'Tukar PIN Saya' },
  // The destination is the floor plan, and "Tables" is what staff call it —
  // the tab heading and the nav label have to be the same word.
  'nav.pos': { en: 'Tables', ms: 'Meja' },
  'nav.kitchen': { en: 'Kitchen', ms: 'Dapur' },
  // "Sales" is what the screen is headed and what staff call it; the nav label
  // has to be the same word.
  'nav.dashboard': { en: 'Sales', ms: 'Jualan' },
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
  'pos.pay': { en: 'Take Payment', ms: 'Ambil Bayaran' },
  'pos.tables': { en: 'Tables', ms: 'Meja' },
  'pos.takeaway': { en: 'Takeaway', ms: 'Bungkus' },
  'pos.newTakeaway': { en: 'New Takeaway', ms: 'Bungkus Baru' },
  'pos.moveOrder': { en: 'Move', ms: 'Pindah' },
  'pos.timeline': { en: 'Order timeline', ms: 'Sejarah Pesanan' },

  'kitchen.heading': { en: 'Kitchen', ms: 'Dapur' },
  'kitchen.served': { en: ' Served (Waiting for Payment)', ms: ' Dihidang (Menunggu Bayaran)' },
  'kitchen.colNew': { en: '🔔 New', ms: '🔔 Baru' },
  'kitchen.colPreparing': { en: '🍳 Cooking', ms: '🍳 Masak' },
  'kitchen.colReady': { en: '✅ Ready', ms: '✅ Siap' },
  'kitchen.colServed': { en: '🍽 Served', ms: '🍽 Dihidang' },

  'dashboard.heading': { en: 'Sales', ms: 'Jualan' },
  'dashboard.topItems': { en: 'Top items today', ms: 'Item Terlaris Hari Ini' },
  'dashboard.hourly': { en: 'Sales by hour', ms: 'Jualan Mengikut Jam' },
  'dashboard.paymentMix': { en: 'Payment mix', ms: 'Kaedah Bayaran' },
  'dashboard.kitchenState': { en: 'Kitchen right now', ms: 'Dapur Sekarang' },

  'customer.subtitle': { en: 'Scan & Order · No app needed', ms: 'Imbas & Pesan · Tiada aplikasi diperlukan' },
  'customer.viewOrder': { en: 'View Order', ms: 'Lihat Pesanan' },
  'customer.yourOrder': { en: 'Your Order', ms: 'Pesanan Anda' },
  'customer.keepBrowsing': { en: 'Keep Browsing', ms: 'Teruskan Melayari' },
  'customer.placeOrder': { en: 'Place Order', ms: 'Buat Pesanan' },
  'customer.orderPlaced': { en: 'Order Placed!', ms: 'Pesanan Dihantar!' },
  'customer.orderMore': { en: 'Browse the menu', ms: 'Lihat Menu' },
  'customer.orderSent': { en: 'Order sent', ms: 'Pesanan Dihantar' },
  'customer.kitchenReceived': { en: 'The kitchen has your order.', ms: 'Dapur telah terima pesanan anda.' },
  'customer.waitingStaff': { en: 'A staff member is checking your order.', ms: 'Staf sedang menyemak pesanan anda.' },
  'voice.title': { en: 'Speak to Order', ms: 'Pesan Dengan Suara' },
  'voice.hint': { en: 'Tap and say what you want, like you would to a waiter.', ms: 'Tekan dan sebut pesanan anda, macam cakap dengan pelayan.' },
  'voice.browse': { en: 'Browse the menu instead', ms: 'Lihat menu sahaja' },
  'voice.listening': { en: 'Listening…', ms: 'Mendengar…' },
  'voice.listeningHint': { en: 'Say your whole order. Tap Done when you finish.', ms: 'Sebut keseluruhan pesanan. Tekan Siap bila habis.' },
  'voice.done': { en: 'Done', ms: 'Siap' },
  'voice.cancel': { en: 'Cancel', ms: 'Batal' },
  'voice.working': { en: 'Getting that down…', ms: 'Sedang catat…' },
  'voice.review': { en: 'Here\u2019s what I got', ms: 'Ini yang saya dapat' },
  'voice.confirm': { en: 'Confirm order', ms: 'Sahkan Pesanan' },
  'voice.again': { en: '🎙 Change with voice', ms: '🎙 Tukar dengan suara' },
  'voice.addMore': { en: '＋ Add more from the menu', ms: '＋ Tambah dari menu' },
  'voice.orderMoreVoice': { en: '🎙 Order more by voice', ms: '🎙 Pesan lagi dengan suara' },
  'voice.blocked': { en: 'Answer the question above first', ms: 'Jawab soalan di atas dahulu' },
  'voice.sending': { en: 'Sending…', ms: 'Menghantar…' },
  'voice.taxNote': { en: 'Service charge and SST, if the restaurant charges them, are added to your bill.', ms: 'Caj perkhidmatan dan SST, jika dikenakan, ditambah pada bil anda.' },

  'customer.paused': { en: 'Online ordering is temporarily paused. Please order with our staff.', ms: 'Pesanan dalam talian dijeda sementara. Sila pesan dengan staf kami.' },
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
