const express = require('express');
const { pool } = require('../db');
const { SESSION_TTL } = require('../lib/auth');
const { subscribe, recent } = require('../lib/events');

const router = express.Router();

// EventSource cannot set a custom Authorization header, so the client passes the
// bearer token as ?token= instead — same session lookup requireRole (lib/auth.js)
// uses, duplicated here rather than widening requireRole itself since this is the
// only route that needs a query-string fallback.
async function authenticateStream(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'login required' });
  const r = await pool.query(
    `SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.created_at > now() - interval '${SESSION_TTL}'`, [token]);
  if (!r.rows[0]) return res.status(401).json({ error: 'invalid session' });
  if (!['admin', 'staff', 'kitchen'].includes(r.rows[0].role)) return res.status(403).json({ error: 'forbidden' });
  req.user = r.rows[0];
  next();
}

router.get('/api/stream', authenticateStream, (req, res) => {
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

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

module.exports = router;
