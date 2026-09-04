// escpos.js — raw ESC/POS byte building. A thermal printer is a socket that
// accepts bytes; a library is not worth the supply chain.
//
// createPrinter(width) returns a chainable builder (methods return itself)
// that accumulates bytes; call .toBuffer() once done to get the payload to
// write to the printer's TCP socket.

function createPrinter(width = 42) {
  const chunks = [];
  const pushBytes = bytes => chunks.push(Buffer.from(bytes));
  const pushText = s => chunks.push(Buffer.from(s, 'latin1'));

  const p = {
    width,

    init() { pushBytes([0x1b, 0x40]); return p; }, // ESC @

    // CP437-safe ASCII: strip anything above 0x7F rather than mis-encode it.
    text(s) {
      pushText(String(s).replace(/[^\x00-\x7f]/g, ''));
      return p;
    },

    align(a) { pushBytes([0x1b, 0x61, a]); return p; }, // ESC a n — 0 left, 1 centre, 2 right

    bold(on) { pushBytes([0x1b, 0x45, on ? 1 : 0]); return p; }, // ESC E n

    doubleHeight(on) { pushBytes([0x1d, 0x21, on ? 0x10 : 0x00]); return p; }, // GS ! n — bit4 = double height

    line(char = '-') { p.text(char.repeat(width) + '\n'); return p; },

    // The one to get right: it's every line of every receipt. Right side is
    // never truncated (it's the price); a long left side is, so it never wraps
    // into the price column. Always emits exactly `width` characters.
    row(left, right) {
      left = String(left);
      right = String(right);
      const maxLeftLen = Math.max(0, width - right.length - 1);
      if (left.length > maxLeftLen) left = left.slice(0, maxLeftLen);
      const gap = Math.max(1, width - left.length - right.length);
      p.text(left + ' '.repeat(gap) + right + '\n');
      return p;
    },

    cut() { pushBytes([0x1d, 0x56, 0x42, 0x00]); return p; }, // GS V 66 0

    drawer() { pushBytes([0x1b, 0x70, 0x00, 25, 250]); return p; }, // ESC p 0 25 250

    toBuffer() { return Buffer.concat(chunks); },
  };

  return p;
}

module.exports = { createPrinter };
