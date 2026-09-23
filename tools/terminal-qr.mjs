// Renders a QR as terminal block characters, so `npm start` can show you the
// LAN address in the form you actually want it: something to point a phone at.
import { encodeQR } from '../shared/qr.js';

/** Render a QR as block characters so it scans straight off the terminal. */
export function terminalQr(text) {
  const qr = encodeQR(text, { ecc: 'M' });
  const border = 2;
  const dim = qr.size + border * 2;
  const dark = (x, y) => {
    const mx = x - border;
    const my = y - border;
    if (mx < 0 || my < 0 || mx >= qr.size || my >= qr.size) return false;
    return qr.modules[my * qr.size + mx] === 1;
  };
  // Two module rows per character cell; a white background keeps the quiet
  // zone bright whatever the terminal theme is.
  const lines = [];
  for (let y = 0; y < dim; y += 2) {
    let line = '';
    for (let x = 0; x < dim; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < dim ? dark(x, y + 1) : false;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`\x1b[30;107m${line}\x1b[0m`);
  }
  return lines.join('\n');
}
