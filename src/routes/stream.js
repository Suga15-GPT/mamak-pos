const express = require('express');
const { requireRole } = require('../lib/auth');
const { subscribe, recent, currentSeq, BOOT_ID } = require('../lib/events');

const router = express.Router();

const STREAM_MAX_MS = () => Number(process.env.STREAM_MAX_MS) || 5 * 60 * 1000;

// Phase 11: sessions are now an httpOnly cookie, which EventSource sends
// automatically on a same-origin connection — the ?token= query-string
// fallback this route needed under bearer-token auth (a live session token
// in reverse-proxy access logs, browser history, anywhere a URL is read) is
// gone, not merely deprioritised. This authenticates exactly like every
// other route now.
router.get('/api/stream', requireRole('admin', 'staff', 'kitchen'), (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // A till that has stopped reading (Wi-Fi gone, a tablet asleep) leaves a
  // stream that can't finish ending; nothing may write to it after end(), and
  // an error on it must never take the process down (re-check 4, F1).
  res.on('error', () => {});
  let closed = false;
  const write = text => { if (!closed && !res.writableEnded) res.write(text); };
  const send = event => write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

  // Where this stream starts, so the page can always reconnect with ?since=,
  // even before it has seen an event (re-check 4, F2), and can tell a server
  // restart (a new boot) from a routine reconnect.
  write(`event: hello\ndata: ${JSON.stringify({ seq: currentSeq(), boot: BOOT_ID })}\n\n`);

  // Last-Event-ID (native browser reconnect) or ?since= (our own manual
  // reconnect). ?since=0 means "everything since this server started".
  const raw = req.headers['last-event-id'] ?? req.query.since;
  recent(raw === undefined || raw === '' ? null : Number(raw)).forEach(send);

  const unsubscribe = subscribe(send);
  const heartbeat = setInterval(() => write(': ping\n\n'), 25000);
  const cleanUp = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(maxAge);
    unsubscribe();
  };
  // Each stream ends after a few minutes; the page reconnects at once with
  // ?since= and misses nothing. The service worker of builds before d5a9b4b
  // copies the stream into its cache, which holds the connection open after
  // its tab is closed — and a browser allows six to one server over plain
  // HTTP. Ending the stream from here lets those go (PR #20 re-check 3, F1).
  // Stop writing first, then end.
  const maxAge = setTimeout(() => { cleanUp(); res.end(); }, STREAM_MAX_MS());

  req.on('close', cleanUp);
});

module.exports = router;
