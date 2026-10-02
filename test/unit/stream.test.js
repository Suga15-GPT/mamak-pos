const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb } = require('../helper');
const { startApp, setup, patch } = require('../apphelper');

/* PR #20 re-check 3, F1: the service worker of builds before d5a9b4b copies
   the live stream into its cache, which keeps the connection open after its
   tab is closed; six of those and the device reaches nothing on the server.
   The server now ends every stream after STREAM_MAX_MS, and a page that
   reconnects with ?since= gets what it missed. */

async function readUntilEnd(res, ms) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; reader.cancel().catch(() => {}); }, ms);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { ended: !timedOut, text };
      text += decoder.decode(value);
    }
  } catch {
    return { ended: false, text };
  } finally {
    clearTimeout(timer);
  }
}

test('the server ends a live stream after STREAM_MAX_MS, and a reconnect with ?since= misses nothing', async () => {
  const prev = process.env.STREAM_MAX_MS;
  process.env.STREAM_MAX_MS = '400';
  try {
    await withDb(async () => {
      const base = await startApp();
      const s = await setup(base);
      const item = s.roti;

      // A first event, so the reconnect has a seq to ask after.
      const first = fetch(`${base}/api/stream`, { headers: s.h });
      await new Promise(r => setTimeout(r, 100));
      await patch(base, s, `/api/admin/items/${item.id}`, { sold_out_today: true });
      const one = await readUntilEnd(await first, 3000);
      assert.equal(one.ended, true, 'the server ended the stream by itself');
      const seq = Number(one.text.match(/^id: (\d+)$/m)[1]);

      // Something happens while no stream is open...
      await patch(base, s, `/api/admin/items/${item.id}`, { sold_out_today: false });

      // ...and the reconnect replays it.
      const two = await readUntilEnd(await fetch(`${base}/api/stream?since=${seq}`, { headers: s.h }), 3000);
      assert.equal(two.ended, true);
      assert.match(two.text, new RegExp(`^id: ${seq + 1}$`, 'm'));
      assert.match(two.text, /event: menu\.updated/);
    });
  } finally {
    if (prev === undefined) delete process.env.STREAM_MAX_MS; else process.env.STREAM_MAX_MS = prev;
  }
});

/* Re-check 4, F2: a screen that has seen no event yet used to reconnect with
   no ?since=, so an order in its one-second gap reached it only at its next
   poll. Every stream now opens with a hello carrying the server's event
   number, and ?since=0 replays from the start. */
test('every stream opens with a hello giving the event number, and ?since= replays from it', async () => {
  const prev = process.env.STREAM_MAX_MS;
  process.env.STREAM_MAX_MS = '300';
  try {
    await withDb(async () => {
      const base = await startApp();
      const s = await setup(base);

      const one = await readUntilEnd(await fetch(`${base}/api/stream`, { headers: s.h }), 3000);
      assert.equal(one.ended, true);
      const hello = JSON.parse(one.text.match(/^event: hello\ndata: (.*)$/m)[1]);
      assert.equal(typeof hello.seq, 'number');
      assert.equal(typeof hello.boot, 'string');

      // The order lands while this screen is away.
      await patch(base, s, `/api/admin/items/${s.roti.id}`, { sold_out_today: true });

      const two = await readUntilEnd(await fetch(`${base}/api/stream?since=${hello.seq}`, { headers: s.h }), 3000);
      assert.match(two.text, new RegExp(`^id: ${hello.seq + 1}$`, 'm'));
      assert.match(two.text, /event: menu\.updated/);
      // And the second hello names the same server run.
      assert.equal(JSON.parse(two.text.match(/^event: hello\ndata: (.*)$/m)[1]).boot, hello.boot);
    });
  } finally {
    if (prev === undefined) delete process.env.STREAM_MAX_MS; else process.env.STREAM_MAX_MS = prev;
  }
});

/* Re-check 4, F1: a till that stops reading leaves a stream whose end() can't
   finish; the next ping or event used to write after end() and the unhandled
   error took the whole server down. */
test('a stream whose till stopped reading ends without taking the server down', async () => {
  const prev = process.env.STREAM_MAX_MS;
  process.env.STREAM_MAX_MS = '500';
  try {
    await withDb(async () => {
      const base = await startApp();
      const s = await setup(base);
      const events = require('../../src/lib/events');
      const before = events.subscriberCount();

      // A till that opens the stream and then reads nothing.
      const http = require('http');
      const { port } = new URL(base);
      const req = http.get({ host: 'localhost', port, path: '/api/stream', headers: { cookie: s.h.cookie } });
      const res = await new Promise(r => req.on('response', r));
      res.pause();
      assert.equal(events.subscriberCount(), before + 1);

      // Far more than the socket buffers hold, so end() can't finish.
      const big = 'x'.repeat(100 * 1024);
      for (let i = 0; i < 150; i++) events.publish('test.fill', { big });
      await new Promise(r => setTimeout(r, 800));   // the stream's time runs out
      events.publish('test.after', { big });       // ...and one more event
      await new Promise(r => setTimeout(r, 200));

      assert.equal(events.subscriberCount(), before, 'the ended stream no longer listens');
      assert.equal((await fetch(`${base}/api/menu`, { headers: s.h })).status, 200, 'the server is still up');
      req.destroy();
    });
  } finally {
    if (prev === undefined) delete process.env.STREAM_MAX_MS; else process.env.STREAM_MAX_MS = prev;
  }
});
