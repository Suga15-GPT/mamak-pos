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
