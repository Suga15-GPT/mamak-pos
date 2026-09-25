// Bilingual (BM/EN) UI chrome — phase 10. Menu item names are entered by the
// restaurant and must render exactly as typed; nothing here ever touches
// them, only the app's own labels/buttons/headings.
const STORAGE_KEY = 'pos_locale';

const translations = {
  'common.logout': { en: 'Log Out', ms: 'Log Keluar' },
  'common.refresh': { en: 'Refresh', ms: 'Muat Semula' },
  'common.changePin': { en: 'Change my PIN', ms: 'Tukar PIN Saya' },
  // The destination is the floor, and in card mode "Cards" is what staff call
  // it — the tab heading and the nav label have to be the same word.
  'nav.pos': { en: 'Cards', ms: 'Kad' },
  'nav.kitchen': { en: 'Kitchen', ms: 'Dapur' },
  // "Sales" is what the screen is headed and what staff call it; the nav label
  // has to be the same word.
  'nav.dashboard': { en: 'Sales', ms: 'Jualan' },
  'nav.shift': { en: 'Shift', ms: 'Syif' },
  'nav.admin': { en: 'Admin', ms: 'Admin' },
  'nav.help': { en: 'Help', ms: 'Bantuan' },

  'login.subtitle': { en: 'Staff & Admin Login', ms: 'Log Masuk Staf & Admin' },
  'login.name': { en: 'Name', ms: 'Nama' },
  'login.pin': { en: 'PIN', ms: 'PIN' },
  'login.submit': { en: 'Log In', ms: 'Log Masuk' },

  'pos.backToTables': { en: 'Back to Cards', ms: 'Kembali ke Kad' },
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
  'pos.tables': { en: 'Cards', ms: 'Kad' },
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

  // Setup wizard and Admin -> Features & setup. Written for a shop owner:
  // what the thing does in the shop, never what it is called in the code.
  'pos.sendOrder': { en: 'Send order', ms: 'Hantar Pesanan' },
  'dashboard.simpleToday': { en: 'Today’s sales', ms: 'Jualan Hari Ini' },
  'dashboard.simpleOrders': { en: '{n} paid orders today', ms: '{n} pesanan dibayar hari ini' },
  'dashboard.simpleHint': { en: 'Turn on the full sales dashboard in Admin → Features & setup for charts.', ms: 'Hidupkan papan jualan penuh di Admin → Ciri & tetapan untuk carta.' },

  'features.adminTab': { en: '🧩 Features & setup', ms: '🧩 Ciri & tetapan' },
  'features.heading': { en: 'What your POS does', ms: 'Apa yang POS anda buat' },
  'features.intro': { en: 'Switch on only what your shop uses. Switching something off hides it — nothing is deleted, and switching it back on brings everything back.', ms: 'Hidupkan hanya apa yang kedai anda guna. Mematikan sesuatu hanya menyembunyikannya — tiada apa dipadam, dan menghidupkannya semula membawa semuanya kembali.' },
  'features.alwaysOn': { en: 'Always on: menu, cards, taking orders, cash / card / eWallet payment, tax and service charge, staff PINs, the activity log, offline orders and Help.', ms: 'Sentiasa hidup: menu, kad, ambil pesanan, bayaran tunai / kad / eWallet, cukai dan caj perkhidmatan, PIN staf, log aktiviti, pesanan luar talian dan Bantuan.' },
  'features.wizardHeading': { en: 'Setup wizard', ms: 'Panduan tetapan' },
  'features.wizardIntro': { en: 'Go through the first-day questions again: shop details, a starting point, cards and QR.', ms: 'Jawab semula soalan hari pertama: butiran kedai, titik permulaan, kad dan QR.' },
  'features.rerun': { en: 'Run setup again', ms: 'Jalankan tetapan semula' },
  'features.saved': { en: 'Saved', ms: 'Disimpan' },
  'features.childOff': { en: '{child} was switched off too, because it needs {parent}.', ms: '{child} juga dimatikan, kerana ia memerlukan {parent}.' },
  'features.needs': { en: 'Needs {parent}', ms: 'Perlukan {parent}' },

  'module.kitchen': { en: 'Kitchen screen', ms: 'Skrin dapur' },
  'module.kitchen.desc': { en: 'Cooks see new orders on a screen and tap them ready. Off: an order is done the moment you send it.', ms: 'Tukang masak lihat pesanan baru di skrin dan tekan bila siap. Mati: pesanan selesai sebaik sahaja dihantar.' },
  'module.stations': { en: 'Separate drinks and food screens', ms: 'Skrin minuman dan makanan berasingan' },
  'module.stations.desc': { en: 'Drinks go to the drinks counter, food to the kitchen, each on its own screen.', ms: 'Minuman ke kaunter minuman, makanan ke dapur, setiap satu di skrin sendiri.' },
  'module.printing': { en: 'Printers', ms: 'Pencetak' },
  'module.printing.desc': { en: 'Print kitchen slips and customer receipts on thermal printers.', ms: 'Cetak slip dapur dan resit pelanggan pada pencetak terma.' },
  'module.shifts': { en: 'Shifts and cash drawer', ms: 'Syif dan laci tunai' },
  'module.shifts.desc': { en: 'Open and close the till with a cash count, record cash in and out, and print end-of-day reports.', ms: 'Buka dan tutup kaunter dengan kiraan tunai, rekod wang masuk dan keluar, dan cetak laporan akhir hari.' },
  'module.discounts': { en: 'Discounts', ms: 'Diskaun' },
  'module.discounts.desc': { en: 'Take money off a bill, or give it free, with an owner’s PIN.', ms: 'Kurangkan harga bil, atau beri percuma, dengan PIN pemilik.' },
  'module.refunds': { en: 'Refunds', ms: 'Bayaran balik' },
  'module.refunds.desc': { en: 'Give money back on a paid bill, with an owner’s PIN.', ms: 'Pulangkan wang untuk bil yang sudah dibayar, dengan PIN pemilik.' },
  'module.split_combine': { en: 'Split and combine bills', ms: 'Pecah dan gabung bil' },
  'module.split_combine.desc': { en: 'Split one bill between friends, or let several cards pay together.', ms: 'Pecahkan satu bil antara kawan, atau biar beberapa kad bayar bersama.' },
  'module.qr': { en: 'Customer QR ordering', ms: 'Pesanan QR pelanggan' },
  'module.qr.desc': { en: 'Customers scan a QR code and order from their own phone.', ms: 'Pelanggan imbas kod QR dan pesan dari telefon sendiri.' },
  'module.voice': { en: 'Speak to Order', ms: 'Pesan Dengan Suara' },
  'module.voice.desc': { en: 'Customers can say their order into their phone instead of tapping.', ms: 'Pelanggan boleh sebut pesanan ke telefon dan bukannya tekan.' },
  'module.dashboard': { en: 'Full sales dashboard', ms: 'Papan jualan penuh' },
  'module.dashboard.desc': { en: 'Charts by hour, top items and payment mix. Off: one simple “Today’s sales” figure.', ms: 'Carta mengikut jam, item terlaris dan kaedah bayaran. Mati: satu angka ringkas “Jualan hari ini”.' },

  'setup.title': { en: 'Set up your POS', ms: 'Sediakan POS anda' },
  'setup.step': { en: 'Step {n} of {total}', ms: 'Langkah {n} daripada {total}' },
  'setup.back': { en: 'Back', ms: 'Kembali' },
  'setup.next': { en: 'Next', ms: 'Seterusnya' },
  'setup.finish': { en: 'Finish setup', ms: 'Selesai' },
  'setup.cancel': { en: 'Cancel', ms: 'Batal' },
  'setup.saving': { en: 'Saving…', ms: 'Menyimpan…' },
  'setup.done': { en: 'All set — your POS is ready.', ms: 'Siap — POS anda sedia.' },
  'setup.shop.title': { en: 'Your shop', ms: 'Kedai anda' },
  'setup.shop.hint': { en: 'Printed at the top of every receipt. You can change these later in Admin.', ms: 'Dicetak di atas setiap resit. Boleh ditukar kemudian di Admin.' },
  'setup.shop.name': { en: 'Shop name', ms: 'Nama kedai' },
  'setup.shop.address': { en: 'Address', ms: 'Alamat' },
  'setup.shop.sst': { en: 'SST registration number (leave empty if you have none)', ms: 'Nombor pendaftaran SST (kosongkan jika tiada)' },
  'setup.shop.tax': { en: 'Service tax (SST) %', ms: 'Cukai perkhidmatan (SST) %' },
  'setup.shop.svc': { en: 'Service charge %', ms: 'Caj perkhidmatan %' },
  'setup.shop.nameRequired': { en: 'Please type your shop name.', ms: 'Sila taip nama kedai anda.' },
  'setup.shop.badRate': { en: 'Percentages must be between 0 and 100.', ms: 'Peratusan mesti antara 0 dan 100.' },
  'setup.preset.title': { en: 'What kind of shop is this?', ms: 'Kedai jenis apa ini?' },
  'setup.preset.hint': { en: 'This only ticks boxes for you on the next step. You can change every one.', ms: 'Ini hanya menanda kotak untuk anda pada langkah seterusnya. Setiap satu boleh ditukar.' },
  'setup.preset.lite': { en: 'Small stall', ms: 'Gerai kecil' },
  'setup.preset.lite.desc': { en: 'Take the order, take the money. Nothing else.', ms: 'Ambil pesanan, ambil bayaran. Itu sahaja.' },
  'setup.preset.medium': { en: 'Busy shop', ms: 'Kedai sibuk' },
  'setup.preset.medium.desc': { en: 'A kitchen screen, printers, shifts, discounts and split bills.', ms: 'Skrin dapur, pencetak, syif, diskaun dan pecah bil.' },
  'setup.preset.advanced': { en: 'Full restaurant', ms: 'Restoran penuh' },
  'setup.preset.advanced.desc': { en: 'Everything, including customer QR ordering and the full dashboard.', ms: 'Semuanya, termasuk pesanan QR pelanggan dan papan jualan penuh.' },
  'setup.preset.required': { en: 'Pick the one closest to your shop to start from.', ms: 'Pilih yang paling hampir dengan kedai anda sebagai permulaan.' },
  'setup.modules.title': { en: 'Choose what your POS does', ms: 'Pilih apa yang POS anda buat' },
  'setup.cards.title': { en: 'How many cards?', ms: 'Berapa banyak kad?' },
  'setup.cards.hint': { en: 'Numbered cards you hand to each customer or table at the counter. You can add more later.', ms: 'Kad bernombor yang anda beri kepada setiap pelanggan atau meja di kaunter. Boleh tambah kemudian.' },
  'setup.cards.label': { en: 'Number of cards', ms: 'Bilangan kad' },
  'setup.cards.bad': { en: 'Type a whole number from 1 to 999.', ms: 'Taip nombor bulat dari 1 hingga 999.' },
  'setup.qr.title': { en: 'How do customers scan?', ms: 'Bagaimana pelanggan imbas?' },
  'setup.qr.per_card': { en: 'A QR printed on each card', ms: 'QR dicetak pada setiap kad' },
  'setup.qr.per_card.desc': { en: 'Each card has its own code. Scanning it orders straight onto that card.', ms: 'Setiap kad ada kod sendiri. Imbasan terus memesan ke kad itu.' },
  'setup.qr.shop': { en: 'One QR for the whole shop', ms: 'Satu QR untuk seluruh kedai' },
  'setup.qr.shop.desc': { en: 'One poster on the wall. Customers type their card number, and staff accept each order.', ms: 'Satu poster di dinding. Pelanggan taip nombor kad, dan staf terima setiap pesanan.' },
  'setup.review.title': { en: 'Check and finish', ms: 'Semak dan selesai' },
  'setup.review.on': { en: 'Switched on', ms: 'Dihidupkan' },
  'setup.review.off': { en: 'Switched off', ms: 'Dimatikan' },
  'setup.review.none': { en: 'Nothing extra — order and pay only.', ms: 'Tiada tambahan — pesan dan bayar sahaja.' },
  'setup.review.cards': { en: '{n} cards', ms: '{n} kad' },
  'setup.review.taxLabel': { en: 'Tax', ms: 'Cukai' },
  'setup.review.tax': { en: 'SST {tax}% · service charge {svc}%', ms: 'SST {tax}% · caj perkhidmatan {svc}%' },
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
