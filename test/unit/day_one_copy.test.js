const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

/* The words on the screens for the day-one fixes: every translation has both
   languages, Help and the handbook explain what the till now does, and
   nothing still offers a seat. */

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function translations() {
  const src = read('public/js/i18n.js');
  const start = src.indexOf('const translations = {');
  const end = src.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start, 'i18n.js has its translations table');
  return vm.runInNewContext(`(${src.slice(start + 'const translations = '.length, end + 2)})`);
}

test('every translation has English and Bahasa Malaysia, including every key the new screens use', () => {
  const t = translations();
  for (const [key, v] of Object.entries(t)) {
    assert.ok(typeof v.en === 'string' && v.en.trim(), `${key}: English`);
    assert.ok(typeof v.ms === 'string' && v.ms.trim(), `${key}: Bahasa Malaysia`);
    // A placeholder in one language is in the other.
    const holes = s => (s.match(/\{\w+\}/g) || []).sort();
    assert.deepEqual(holes(v.ms), holes(v.en), `${key}: the same {placeholders}`);
  }
  const used = new Set();
  for (const f of ['public/index.html', 'public/js/pos.js', 'public/js/admin.js', 'public/js/setup.js']) {
    for (const m of read(f).matchAll(/(?:data-i18n="|\bt\(')([a-zA-Z]+\.[\w.]+)['"]/g)) used.add(m[1]);
  }
  for (const key of used) assert.ok(t[key], `${key} is used on a screen but has no translation`);
  for (const key of ['setup.review.salesKept', 'merge.separate', 'split.byItems', 'pay.part', 'clear.heading']) {
    assert.ok(used.has(key), `${key} is on a screen`);
  }
  assert.equal(t['setup.review.salesKept'].en, 'Your sales history is kept. To start from RM0, use Admin → System → Clear sales data.');
});

test('Help and the handbook explain Combine, Split by items, Pay part of the bill and Clear sales data; nothing offers a seat', () => {
  const help = read('public/js/help.js');
  const handbook = read('docs/HOW-TO-USE-MAMAK-POS.md');
  for (const [name, text] of [['help.js', help], ['the handbook', handbook]]) {
    assert.doesNotMatch(text, /\bseat/i, `${name} still mentions seats`);
    for (const phrase of ['Split by items', 'Pay part of the bill', 'Clear sales data', 'Separate Card 4', 'Card 1 (from 4)']) {
      assert.ok(text.includes(phrase), `${name} explains "${phrase}"`);
    }
  }
  assert.match(help, /id: 'combine'/);
  assert.match(help, /id: 'clear-sales'/);
  const page = read('public/index.html') + read('public/js/pos.js');
  assert.doesNotMatch(page, /split-by-seat|set-seat|seat-btn|Split by seat/);
  // "Pay a specific amount" sits folded away behind "Pay part of the bill".
  assert.match(read('public/index.html'), /<div id="pay-amount-row" hidden/);
  assert.match(read('public/index.html'), /id="pay-part-toggle"[^>]*aria-expanded="false"/);
});

test('the runbook says how to restore cleared sales', () => {
  const runbook = read('docs/RUNBOOK.md');
  assert.match(runbook, /## Restore cleared sales data/);
  assert.match(runbook, /node scripts\/restore-sales-archive\.js --list/);
  assert.match(runbook, /node scripts\/restore-sales-archive\.js archive_\d{8}_\d{6}/);
});
