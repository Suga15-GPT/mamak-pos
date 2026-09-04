const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb, getFreePort } = require('../helper');
const { pinPolicyError } = require('../../src/lib/auth');

const SRC_DIR = path.join(__dirname, '..', '..', 'src') + path.sep;
const DB_MODULE = require.resolve('../../src/db');
const SERVER_MODULE = require.resolve('../../src/server');

function clearSrcCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_DIR) && key !== DB_MODULE) delete require.cache[key];
  }
}

async function waitReady(base, retries = 50) {
  for (let i = 0; i < retries; i++) {
    try { await fetch(`${base}/api/menu`); return; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error(`server at ${base} never became ready`);
}

async function startApp() {
  const port = await getFreePort();
  process.env.PORT = String(port);
  process.env.ADMIN_PIN = '1234';
  clearSrcCache();
  require(SERVER_MODULE);
  const base = `http://localhost:${port}`;
  await waitReady(base);
  return base;
}

async function json(res) { return res.json(); }
// Phase 11: sessions are an httpOnly cookie, not a bearer token — node's
// fetch happily sends a manually-set Cookie header (it isn't a browser
// sandbox), so tests carry the session by hand instead of a cookie jar.
async function login(base, name, pin) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin }),
  });
  const body = await json(r);
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrfToken: body.csrf_token, body };
}
function auth(session) {
  return { cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' };
}

async function adminSession(base) { return login(base, 'Admin', '1234'); }

test('PIN policy: rejects 1234/0000/4321, accepts 7392', () => {
  assert.ok(pinPolicyError('1234'));
  assert.ok(pinPolicyError('0000'));
  assert.ok(pinPolicyError('4321'));
  assert.equal(pinPolicyError('7392'), null);
});

test('last active admin cannot be deactivated or demoted -> 400', async () => {
  await withDb(async () => {
    const base = await startApp();
    const admin = await adminSession(base);

    const dead = await fetch(`${base}/api/admin/users/1`, {
      method: 'PATCH', headers: auth(admin), body: JSON.stringify({ active: false }),
    });
    assert.equal(dead.status, 400);

    const demoted = await fetch(`${base}/api/admin/users/1`, {
      method: 'PATCH', headers: auth(admin), body: JSON.stringify({ role: 'staff' }),
    });
    assert.equal(demoted.status, 400);
  });
});

test('an admin cannot deactivate themselves even when other admins exist -> 400', async () => {
  await withDb(async () => {
    const base = await startApp();
    const admin = await adminSession(base);
    const second = await json(await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ name: 'Second Admin', role: 'admin', pin: '7392' }),
    }));

    const r = await fetch(`${base}/api/admin/users/1`, {
      method: 'PATCH', headers: auth(admin), body: JSON.stringify({ active: false }),
    });
    assert.equal(r.status, 400);

    // The second admin deactivating themselves is blocked the same way, even
    // though the first admin (id 1) is still active.
    const secondSession = await login(base, 'Second Admin', '7392');
    const secondAuth = auth(secondSession);
    // A brand-new account starts with must_change_pin — clear it first so
    // this exercises self-deactivation, not that separate gate.
    await fetch(`${base}/api/me/pin`, {
      method: 'POST', headers: secondAuth, body: JSON.stringify({ current_pin: '7392', new_pin: '5273' }),
    });
    const r2 = await fetch(`${base}/api/admin/users/${second.id}`, {
      method: 'PATCH', headers: secondAuth, body: JSON.stringify({ active: false }),
    });
    assert.equal(r2.status, 400);
  });
});

test('inactive user cannot log in -> 401', async () => {
  await withDb(async () => {
    const base = await startApp();
    const admin = await adminSession(base);
    const staff = await json(await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ name: 'Ali', role: 'staff', pin: '7392' }),
    }));
    await fetch(`${base}/api/admin/users/${staff.id}`, { method: 'PATCH', headers: auth(admin), body: JSON.stringify({ active: false }) });

    const r = await login(base, 'Ali', '7392');
    assert.equal(r.status, 401);
  });
});

test('deactivating a user mid-shift kills their live session immediately', async () => {
  await withDb(async () => {
    const base = await startApp();
    const admin = await adminSession(base);
    const staff = await json(await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ name: 'Bee', role: 'staff', pin: '7392' }),
    }));
    const staffSession = await login(base, 'Bee', '7392');
    // A brand-new account starts with must_change_pin — clear it first so
    // this test exercises deactivation, not that separate gate.
    await fetch(`${base}/api/me/pin`, {
      method: 'POST', headers: auth(staffSession), body: JSON.stringify({ current_pin: '7392', new_pin: '5273' }),
    });

    const before = await fetch(`${base}/api/tables`, { headers: auth(staffSession) });
    assert.equal(before.status, 200);

    await fetch(`${base}/api/admin/users/${staff.id}`, { method: 'PATCH', headers: auth(admin), body: JSON.stringify({ active: false }) });

    const after = await fetch(`${base}/api/tables`, { headers: auth(staffSession) });
    assert.equal(after.status, 401);
  });
});

test('own PIN change with the wrong current PIN -> 401; correct change works and kills other sessions', async () => {
  await withDb(async () => {
    const base = await startApp();
    const admin = await adminSession(base);
    const staff = await json(await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ name: 'Cee', role: 'staff', pin: '7392' }),
    }));
    const session1 = await login(base, 'Cee', '7392');
    const session2 = await login(base, 'Cee', '7392');

    const wrong = await fetch(`${base}/api/me/pin`, {
      method: 'POST', headers: auth(session1), body: JSON.stringify({ current_pin: '0000', new_pin: '5273' }),
    });
    assert.equal(wrong.status, 401);

    const good = await fetch(`${base}/api/me/pin`, {
      method: 'POST', headers: auth(session1), body: JSON.stringify({ current_pin: '7392', new_pin: '5273' }),
    });
    assert.equal(good.status, 200);

    // session1 (the one that made the change) survives; session2 is killed.
    const stillGood = await fetch(`${base}/api/tables`, { headers: auth(session1) });
    assert.equal(stillGood.status, 200);
    const killed = await fetch(`${base}/api/tables`, { headers: auth(session2) });
    assert.equal(killed.status, 401);

    // The old PIN no longer works; the new one does.
    const oldPinLogin = await login(base, 'Cee', '7392');
    assert.equal(oldPinLogin.status, 401);
    const newPinLogin = await login(base, 'Cee', '5273');
    assert.equal(newPinLogin.status, 200);
  });
});

test('admin reset-pin clears that user\'s sessions and sets must_change_pin', async () => {
  await withDb(async () => {
    const base = await startApp();
    const admin = await adminSession(base);
    const staff = await json(await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ name: 'Dee', role: 'staff', pin: '7392' }),
    }));
    const staffSession = await login(base, 'Dee', '7392');
    // A brand-new account starts with must_change_pin — clear it first so
    // this test exercises the reset-pin route, not that separate gate.
    await fetch(`${base}/api/me/pin`, {
      method: 'POST', headers: auth(staffSession), body: JSON.stringify({ current_pin: '7392', new_pin: '5273' }),
    });
    assert.equal((await fetch(`${base}/api/tables`, { headers: auth(staffSession) })).status, 200);

    const reset = await fetch(`${base}/api/admin/users/${staff.id}/reset-pin`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ new_pin: '4568' }),
    });
    assert.equal(reset.status, 200);

    // Old session is dead.
    assert.equal((await fetch(`${base}/api/tables`, { headers: auth(staffSession) })).status, 401);

    // must_change_pin came back true on the fresh login, and every route but
    // /api/me/pin and /api/logout is blocked until it's changed.
    const relogin = await login(base, 'Dee', '4568');
    assert.equal(relogin.status, 200);
    assert.equal(relogin.body.must_change_pin, true);
  });
});

test('must_change_pin blocks every route except POST /api/me/pin and POST /api/logout, until changed', async () => {
  await withDb(async () => {
    const base = await startApp();
    const admin = await adminSession(base);
    const staff = await json(await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ name: 'Ellie', role: 'staff', pin: '7392' }),
    }));
    // A freshly-created user always starts with must_change_pin = true.
    const session = await login(base, 'Ellie', '7392');
    assert.equal(session.body.must_change_pin, true);

    const blocked = await fetch(`${base}/api/tables`, { headers: auth(session) });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error, 'pin_change_required');

    const changed = await fetch(`${base}/api/me/pin`, {
      method: 'POST', headers: auth(session), body: JSON.stringify({ current_pin: '7392', new_pin: '4568' }),
    });
    assert.equal(changed.status, 200);

    const nowAllowed = await fetch(`${base}/api/tables`, { headers: auth(session) });
    assert.equal(nowAllowed.status, 200);
  });
});

test('deactivating "Ali" then creating a new "Ali" succeeds', async () => {
  await withDb(async () => {
    const base = await startApp();
    const admin = await adminSession(base);
    const first = await json(await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ name: 'Ali', role: 'staff', pin: '7392' }),
    }));
    await fetch(`${base}/api/admin/users/${first.id}`, { method: 'PATCH', headers: auth(admin), body: JSON.stringify({ active: false }) });

    const second = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ name: 'Ali', role: 'kitchen', pin: '4568' }),
    });
    assert.equal(second.status, 200);
    const secondBody = await json(second);
    assert.notEqual(secondBody.id, first.id);
  });
});

test('DELETE /api/admin/users/:id is retired -> 410, points at the replacement', async () => {
  await withDb(async () => {
    const base = await startApp();
    const admin = await adminSession(base);
    const staff = await json(await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ name: 'Fen', role: 'staff', pin: '7392' }),
    }));
    const r = await fetch(`${base}/api/admin/users/${staff.id}`, { method: 'DELETE', headers: auth(admin) });
    assert.equal(r.status, 410);
  });
});

test('a mutating request without the CSRF header is rejected', async () => {
  await withDb(async () => {
    const base = await startApp();
    const admin = await adminSession(base);
    const r = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'NoCsrf', role: 'staff', pin: '7392' }),
    });
    assert.equal(r.status, 403);
  });
});
