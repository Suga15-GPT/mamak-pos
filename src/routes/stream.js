const express = require('express');
const { requireRole } = require('../lib/auth');
const { subscribe, recent } = require('../lib/events');

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

  const send = event => {
    res.write(`id: ${event.seq}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Last-Event-ID (native browser reconnect) or ?since= (our own manual reconnect)
  const since = Number(req.headers['last-event-id'] || req.query.since || 0);
  recent(since).forEach(send);

  const unsubscribe = subscribe(send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  // Each stream ends after a few minutes; the page reconnects at once with
  // ?since= and misses nothing. The service worker of builds before d5a9b4b
  // copies the stream into its cache, which holds the connection open after
  // its tab is closed — and a browser allows six to one server over plain
  // HTTP. Ending the stream from here lets those go (PR #20 re-check 3, F1).
  const maxAge = setTimeout(() => res.end(), STREAM_MAX_MS());

  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(maxAge);
    unsubscribe();
  });
});

module.exports = router;
