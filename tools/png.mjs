// Minimal PNG writer (8-bit grayscale, no filtering) used by the test harness
// to hand real images to a real QR decoder.
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** @param {Uint8Array} gray row-major grayscale pixels, one byte each. */
export function grayscalePng(gray, width, height) {
  return encodePng(gray, width, height, 1, 0);
}

/** @param {Uint8Array} rgba row-major pixels, four bytes each. */
export function rgbaPng(rgba, width, height) {
  return encodePng(rgba, width, height, 4, 6);
}

function encodePng(pixels, width, height, channels, colourType) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // Filter type: none.
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth.
  ihdr[9] = colourType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Render a QR result to a PNG buffer. */
export function qrToPng(qr, { scale = 8, border = 4 } = {}) {
  const dim = (qr.size + border * 2) * scale;
  const gray = new Uint8Array(dim * dim).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y * qr.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((y + border) * scale + dy) * dim + (x + border) * scale;
        gray.fill(0, row, row + scale);
      }
    }
  }
  return grayscalePng(gray, dim, dim);
}
