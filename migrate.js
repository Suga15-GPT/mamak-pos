const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    await pool.query(`
      ALTER TABLE modifier_options 
      ADD COLUMN IF NOT EXISTS available BOOLEAN NOT NULL DEFAULT true;
    `);
    console.log('Migration complete: added available column to modifier_options');
    process.exit(0);
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  }
}

migrate();