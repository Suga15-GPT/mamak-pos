function AppError(message, status) {
  return Object.assign(new Error(message), { status });
}

const awaitH = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message || 'server error' }); });

/* like awaitH, but never leaks internal error details to unauthenticated callers */
const publicH = fn => (req, res) => fn(req, res).catch(e => {
  if (e.status) return res.status(e.status).json({ error: e.message });
  console.error(e);
  res.status(500).json({ error: 'server error' });
});

module.exports = { AppError, awaitH, publicH };
