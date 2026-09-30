const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const { withDb, TEST_DATABASE_URL, getFreePort } = require('../helper');
const { startApp, login } = require('../apphelper');

/* How an install is configured: the database password reaches the app on its
   own (PGPASSWORD), never inside a URL, so any characters work; DATABASE_URL
   still wins when an install sets it; and BASE_URL is this PC's LAN address,
   with a warning at boot in production when it is localhost. */

const ROOT = path.join(__dirname, '..', '..');
const DB_MODULE = require.resolve('../../src/db');
const PASSWORD = 'Xk3/Qm9+Tz4=#@';
const CONNECTION_VARS = ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGOPTIONS'];

function saveEnv(keys) {
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  return () => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
}

const composeFile = () => fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n');
const appService = yml => yml.match(/^ {2}app:\n([\s\S]*?)(?=^ {2}\S|^\S)/m)[1];

/* The app service's environment as docker compose hands it over, with the
   .env values given here put into its ${VAR}, ${VAR:-default} and
   ${VAR:?message} references. */
function composeAppEnv(dotenv) {
  const block = appService(composeFile()).match(/^ {4}environment:\n((?: {6}.*\n)+)/m)[1];
  const env = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^ {6}([A-Z_][A-Z0-9_]*): (.*)$/);
    if (!m) continue;
    const raw = m[2].trim().replace(/^"(.*)"$/, '$1');
    env[m[1]] = raw.replace(/\$\{(\w+)(?::([-?])([^}]*))?\}/g, (_, name, op, arg) => {
      const v = dotenv[name];
      if (op === '?' && !v) throw new Error(`${name}: ${arg}`);
      return v || (op === '-' ? arg : '');
    });
  }
  return env;
}

test('the app runs on the database password Xk3/Qm9+Tz4=#@, handed over the way docker-compose.yml hands it', async t => {
  const url = new URL(TEST_DATABASE_URL);
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  const role = `test_${crypto.randomBytes(6).toString('hex')}`;
  const restoreEnv = saveEnv(CONNECTION_VARS);
  try {
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${PASSWORD}'`);
    await admin.query(`CREATE SCHEMA "${role}" AUTHORIZATION "${role}"`);

    // In a postgres:// URL, the same password is no address at all.
    assert.throws(() => new Client({ connectionString: `postgres://${role}:${PASSWORD}@${url.host}/postgres` }), /Invalid URL/);

    // Compose's connection settings, with POSTGRES_PASSWORD=Xk3/Qm9+Tz4=#@ in
    // .env. They name its own db container and the postgres user; here the
    // host, port, user and database are this test server and a role with that
    // password. The password is compose's.
    const compose = composeAppEnv({ POSTGRES_PASSWORD: PASSWORD, ADMIN_PIN: '7392' });
    for (const k of CONNECTION_VARS) {
      if (compose[k] === undefined) delete process.env[k]; else process.env[k] = compose[k];
    }
    Object.assign(process.env, {
      PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1) || 'postgres',
      PGUSER: role, PGOPTIONS: `-c search_path=${role}`,
    });

    // This only proves something on a server that checks passwords: one
    // character short must be refused.
    const wrong = new Client({ password: PASSWORD.slice(0, -1) });
    const refused = await wrong.connect().then(() => wrong.end().then(() => null), e => e);
    if (!refused) {
      t.skip('this Postgres lets any password in (trust), so it cannot tell a right one from a wrong one');
      return;
    }
    assert.match(refused.message, /password authentication failed/);

    delete require.cache[DB_MODULE];
    const db = require(DB_MODULE);
    try {
      // Asked first on its own: a boot that cannot connect retries for half a
      // minute and then exits.
      assert.equal((await db.query('SELECT current_user AS u')).rows[0].u, role);
      const base = await startApp(); // migrates, seeds and serves, as that role
      assert.ok((await login(base, 'Admin', '1234')).csrfToken, 'the app serves a login');
    } finally {
      await db.pool.end();
      delete require.cache[DB_MODULE];
    }
  } finally {
    restoreEnv();
    await admin.query(`DROP SCHEMA IF EXISTS "${role}" CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
  }
});

test('an install that sets DATABASE_URL connects with it exactly as before, whatever PG* variables are also about', async () => {
  const restoreEnv = saveEnv(CONNECTION_VARS);
  try {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    Object.assign(process.env, { PGUSER: 'nobody', PGPASSWORD: 'not-this-one', PGDATABASE: 'nowhere' });
    delete require.cache[DB_MODULE];
    const db = require(DB_MODULE);
    try {
      const r = (await db.query('SELECT current_user AS u, current_database() AS d')).rows[0];
      const url = new URL(TEST_DATABASE_URL);
      assert.deepEqual(r, { u: decodeURIComponent(url.username), d: url.pathname.slice(1) });
    } finally {
      await db.pool.end();
      delete require.cache[DB_MODULE];
    }
  } finally {
    restoreEnv();
  }
});

test('docker-compose.yml gives the app its database password on its own, never inside a URL', () => {
  const yml = composeFile();
  const app = appService(yml);
  assert.match(app, /^ +PGPASSWORD: \$\{POSTGRES_PASSWORD:\?[^}]*\}$/m);
  assert.match(app, /^ +PGHOST: db$/m);
  assert.match(app, /^ +PGUSER: postgres$/m);
  assert.match(app, /^ +PGDATABASE: postgres$/m);
  assert.doesNotMatch(app, /^ +DATABASE_URL:/m, 'no URL for pg to parse');
  assert.doesNotMatch(yml, /:\/\/\S*\$\{POSTGRES_PASSWORD/, 'no URL anywhere carries the password');
});

test('.env.example says plainly that BASE_URL is this PC\'s LAN address, because QR codes and NFC tags contain it', () => {
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').replace(/\r\n/g, '\n');
  const block = env.split(/\n\n/).find(b => /^BASE_URL=/m.test(b));
  const text = block.replace(/\n# ?/g, ' ');
  assert.match(text, /BASE_URL must be this PC's LAN address, e\.g\. http:\/\/192\.168\.x\.x:3000/);
  assert.match(text, /every QR code and NFC tag contains this address/);
  assert.match(text, /Never localhost/);
  assert.doesNotMatch(block, /^BASE_URL=.*localhost/m, 'the example value is not localhost');
});

// Starts the real server in a child process and returns what it printed by
// the time it was listening (plus a moment for stderr to arrive).
async function boot(env) {
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), ADMIN_PIN: '7392', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no boot within 20s:\n${stdout}\n${stderr}`)), 20000);
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`exited ${code}:\n${stdout}\n${stderr}`)); });
      const check = () => { if (stdout.includes(`POS API + static on :${port}`)) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', check);
    });
    await new Promise(r => setTimeout(r, 300));
    return { stdout, stderr };
  } finally {
    child.kill();
  }
}

test('in production, a BASE_URL on localhost gets a plain warning at boot; a LAN address, or a development boot, gets none', async () => {
  const { localBaseUrlWarning } = require('../../src/lib/baseurl');
  const restoreEnv = saveEnv(['BASE_URL']);
  try {
    for (const [value, warns] of [
      ['http://localhost:3000', true], ['http://LOCALHOST:3000/', true], ['localhost:3000', true],
      ['http://127.0.0.1:3000', true], ['http://[::1]:3000', true], ['http://0.0.0.0:3000', true],
      ['http://192.168.1.20:3000', false], ['https://pos.example.com', false], ['', false], [undefined, false],
    ]) {
      if (value === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = value;
      assert.equal(Boolean(localBaseUrlWarning()), warns, `BASE_URL=${value}`);
    }
  } finally {
    restoreEnv();
  }

  await withDb(async () => {
    const local = await boot({ NODE_ENV: 'production', BASE_URL: 'http://localhost:3000' });
    assert.match(local.stderr, /WARNING: BASE_URL is http:\/\/localhost:3000, which only this PC can open\./);
    assert.match(local.stderr, /Every QR code and NFC tag contains BASE_URL/);
    assert.match(local.stderr, /Set BASE_URL in \.env to this PC's LAN address, e\.g\. http:\/\/192\.168\.x\.x:3000/);

    const lan = await boot({ NODE_ENV: 'production', BASE_URL: 'http://192.168.1.20:3000' });
    assert.doesNotMatch(lan.stderr, /BASE_URL/);

    const dev = await boot({ NODE_ENV: 'development', BASE_URL: 'http://localhost:3000' });
    assert.doesNotMatch(dev.stderr, /BASE_URL/);
  });
});
