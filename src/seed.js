const crypto = require('crypto');
const { pool, migrate } = require('./db');
const { hashPin } = require('./lib/auth');

const CATS = ['Nasi Kandar', 'Mee & Goreng', 'Roti', 'Minuman Panas', 'Minuman Ais', 'Extras'];
const ITEMS = [
  [0, 'Nasi Kandar Ayam', 1200, true], [0, 'Nasi Kandar Daging', 1300, true],
  [0, 'Nasi Kandar Campur', 1400, true], [0, 'Nasi Kandar Sotong', 1500, true],
  [0, 'Nasi Kandar Udang', 1600, true],
  [1, 'Mee Goreng Mamak', 850, false], [1, 'Maggi Goreng', 800, false],
  [1, 'Nasi Goreng Kampung', 900, false], [1, 'Mee Rebus', 850, false],
  [2, 'Roti Canai', 200, false], [2, 'Roti Telur', 350, false],
  [2, 'Roti Tissue', 300, false], [2, 'Murtabak Ayam', 800, false],
  [3, 'Teh Tarik', 280, false], [3, 'Milo Panas', 320, false],
  [3, 'Kopi O', 250, false], [3, 'Teh Halia', 300, false],
  [4, 'Teh Tarik Ais', 350, false], [4, 'Milo Ais', 380, false],
  [4, 'Limau Ais', 300, false], [4, 'Sirap Bandung', 300, false],
  [5, 'Telur', 250, false], [5, 'Vadai', 250, false],
  [5, 'Samosa', 200, false], [5, 'Sambal', 150, false],
];

async function seed() {
  await migrate();

  const c = await pool.query('SELECT count(*)::int n FROM categories');
  if (c.rows[0].n === 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const catIds = [];
      for (const name of CATS)
        catIds.push((await client.query('INSERT INTO categories (name) VALUES ($1) RETURNING id', [name])).rows[0].id);
      for (const [ci, name, cents, kandar] of ITEMS)
        await client.query('INSERT INTO items (category_id, name, price_cents, kandar) VALUES ($1,$2,$3,$4)',
          [catIds[ci], name, cents, kandar]);
      // min_select/max_select match what migrations/004_menu.sql backfills onto
      // pre-existing radio/checkbox groups — a fresh seed should behave the same.
      const g1 = (await client.query(
        "INSERT INTO modifier_groups (name, mode, min_select, max_select) VALUES ('Kuah','radio',1,1) RETURNING id")).rows[0].id;
      const g2 = (await client.query(
        "INSERT INTO modifier_groups (name, mode, min_select, max_select) VALUES ('Extra Lauk','checkbox',0,99) RETURNING id")).rows[0].id;
      for (const n of ['Banjir', 'Asing', 'Lebih Kuah'])
        await client.query('INSERT INTO modifier_options (group_id, name, price_cents, available) VALUES ($1,$2,0,true)', [g1, n]);
      for (const [n, p] of [['Telur', 250], ['Bendi', 200], ['Sambal', 150], ['Lebih Nasi', 200]])
        await client.query('INSERT INTO modifier_options (group_id, name, price_cents, available) VALUES ($1,$2,$3,true)', [g2, n, p]);
      // Same backfill migrations/004_menu.sql does for existing rows — needed here too
      // because on a fresh install, seed() creates items *after* migrate() already ran,
      // so the migration's own backfill (which runs against an empty items table) attaches nothing.
      await client.query('INSERT INTO item_modifier_groups (item_id, group_id) SELECT id, $1 FROM items WHERE kandar ON CONFLICT DO NOTHING', [g1]);
      await client.query('INSERT INTO item_modifier_groups (item_id, group_id) SELECT id, $1 FROM items WHERE kandar ON CONFLICT DO NOTHING', [g2]);
      await client.query('COMMIT');
      console.log('Seeded menu + modifiers');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  const t = await pool.query('SELECT count(*)::int n FROM tables');
  if (t.rows[0].n === 0) {
    const names = [...Array(12)].map((_, i) => `T${i + 1}`).concat(['Counter', 'Takeaway']);
    for (const n of names)
      await pool.query('INSERT INTO tables (name, qr_token) VALUES ($1,$2)', [n, crypto.randomBytes(5).toString('hex')]);
    console.log('Seeded 14 tables');
  }
  const u = await pool.query('SELECT count(*)::int n FROM users');
  if (u.rows[0].n === 0) {
    const pin = process.env.ADMIN_PIN || '1234';
    await pool.query("INSERT INTO users (name, role, pin_hash) VALUES ('Admin','admin',$1)", [hashPin(pin)]);
    console.log(`Seeded admin user (name: Admin, PIN: ${pin}) — CHANGE THIS PIN IN PRODUCTION`);
  }
}

module.exports = { seed, CATS, ITEMS };
