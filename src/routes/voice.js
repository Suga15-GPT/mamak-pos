const express = require('express');
const { publicH } = require('../lib/errors');
const { rateLimit } = require('../lib/auth');
const voice = require('../services/voice');
const { resolveQr } = require('../services/cards');
const { requireFeature } = require('../services/features');

const router = express.Router();

/* ===== SPEAK TO ORDER (public) =====
   One endpoint, one round trip: audio in, a validated and POS-priced proposal
   out. It writes nothing. The customer's confirmation goes to the ordinary
   POST /api/public/orders, which is what creates the dining order and the
   kitchen round — so voice cannot reach a printer, a station display or a bill
   on its own, and a customer who walks away mid-preview leaves no trace.

   Every message in here is written to be read by a diner. Provider failures are
   logged server-side and become "we couldn't hear that" on the phone: an API
   error body is not something to show somebody waiting for their roti. */

const FRIENDLY = {
  disabled: 'Voice ordering is not switched on here. Please browse the menu instead.',
  bad_audio: 'That recording did not come through. Please try again.',
  too_long: 'That was a bit long — try again in a few short sentences.',
  busy: 'Too many voice orders from this table just now. Please browse the menu or ask our staff.',
  failed: 'Sorry, we could not hear that clearly. Please try again.',
};

router.post('/api/public/voice/interpret', requireFeature('qr', 'voice'), publicH(async (req, res) => {
  const { table_token: tableToken, card_number: cardNumber, audio_base64: audioB64, mime_type: mimeType, draft } = req.body || {};
  // The card's own QR token (or, in shop mode, the shop token plus the typed
  // card number) is the entire identity, exactly as it is for a typed QR
  // order. No session, no staff endpoint, no order id. QR mode 'off' is a 404
  // here too.
  let card;
  try {
    ({ card } = await resolveQr(tableToken, cardNumber));
  } catch (e) {
    if (e.code === 'qr_off') return res.status(404).json({ error: 'qr_off', message: e.message });
    return res.status(400).json({ error: 'invalid_card', message: 'Please scan the QR code on your card again.' });
  }
  if (!voice.isEnabled()) return res.status(503).json({ error: 'voice_disabled', message: FRIENDLY.disabled });

  // Voice costs money per utterance, so it is limited harder than tapping the
  // menu is — per IP and per card, because one hotspot at a busy table is one
  // IP for a whole group of diners.
  if (!rateLimit('voice:' + req.ip, 15, 10 * 60 * 1000)) return res.status(429).json({ error: 'rate_limited', message: FRIENDLY.busy });
  if (!rateLimit('voicecard:' + card.id, 25, 10 * 60 * 1000)) return res.status(429).json({ error: 'rate_limited', message: FRIENDLY.busy });

  let buffer;
  try {
    buffer = Buffer.from(String(audioB64 || ''), 'base64');
  } catch {
    return res.status(400).json({ error: 'bad_audio', message: FRIENDLY.bad_audio });
  }

  // The draft is the customer's own preview coming back so a correction can be
  // applied to it. It is untrusted and used only as context for the model —
  // every line it produces is re-read from the database below regardless.
  const draftLines = Array.isArray(draft) ? draft.slice(0, voice.MAX_LINES).map(l => ({
    item_id: Number(l && l.item_id) || 0,
    name: String((l && l.name) || '').slice(0, 80),
    qty: Number(l && l.qty) || 1,
    mods: Array.isArray(l && l.mods) ? l.mods.slice(0, 12).map(m => ({ name: String((m && m.name) || '').slice(0, 60) })) : [],
    note: String((l && l.note) || '').slice(0, 200),
  })) : [];

  try {
    const result = await voice.interpretUtterance({ buffer, mimeType: String(mimeType || ''), draftLines });
    return res.json(result);
  } catch (e) {
    if (e.code === 'bad_audio' || e.code === 'too_long') {
      return res.status(400).json({ error: e.code, message: FRIENDLY[e.code] });
    }
    // Anything else is the speech or language provider having a bad day. The
    // detail stays in the server log where it is useful.
    console.error('voice interpret failed:', e.message, e.detail || '');
    return res.status(502).json({ error: 'voice_failed', message: FRIENDLY.failed });
  }
}));

module.exports = router;
