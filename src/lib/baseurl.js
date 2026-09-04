/* Where a customer's phone will actually reach this POS.

   A table QR is printed once and stuck to a table for months; if it encodes
   `http://localhost:3000` because BASE_URL was never set, every one of them is
   silently useless and nobody finds out until a customer complains. So the URL
   is derived rather than hardcoded, and Admin is told plainly when the derived
   value could not work from a phone. */

function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }

function configuredBaseUrl() {
  const v = trimSlash(process.env.BASE_URL);
  return v || null;
}

// The request's own origin, honouring X-Forwarded-Proto/Host only when the app
// is explicitly configured to trust a proxy (server.js, TRUST_PROXY=1) — the
// same reasoning that gates `trust proxy` there: an untrusted forwarded header
// is attacker-controlled.
function requestBaseUrl(req) {
  if (!req) return null;
  const host = req.get ? req.get('host') : req.headers?.host;
  if (!host) return null;
  const proto = req.protocol || 'http';
  return trimSlash(`${proto}://${host}`);
}

function publicBaseUrl(req) {
  return configuredBaseUrl() || requestBaseUrl(req) || 'http://localhost:3000';
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i;

/* A structured verdict Admin can render as "QR Status: Working" or a specific
   warning. Never claims healthy without a reason to. */
function qrHealth(req) {
  const configured = configuredBaseUrl();
  const url = publicBaseUrl(req);
  const problems = [];
  let parsed = null;
  try { parsed = new URL(url); } catch { problems.push(`BASE_URL is not a valid URL: ${url}`); }

  if (parsed) {
    if (LOCAL_HOST.test(parsed.hostname)) {
      problems.push(`QR codes would point at ${parsed.hostname}, which only resolves on the POS machine itself. `
        + 'A customer phone cannot open it. Set BASE_URL to the address customers reach.');
    }
    if (!configured) {
      problems.push('BASE_URL is not set, so QR links are guessed from whichever address the admin browser used. '
        + 'Set BASE_URL so printed QR codes stay correct.');
    }
  }

  const warnings = [];
  if (parsed && parsed.protocol === 'http:' && !LOCAL_HOST.test(parsed.hostname)) {
    warnings.push('QR links are plain HTTP. HTTPS is recommended for a public address.');
  }

  return { base_url: url, configured: !!configured, ok: problems.length === 0, problems, warnings };
}

module.exports = { configuredBaseUrl, requestBaseUrl, publicBaseUrl, qrHealth };
