// A dependency-free QR Code (Model 2) encoder.
//
// Supports byte and alphanumeric segments, versions 1-40, all four ECC levels,
// automatic mask selection and ECC boosting. Mixed-mode segmentation matters
// here: a PassIt link is a short lowercase prefix followed by a long run of
// base32, and encoding that run as alphanumeric (5.5 bits/char) instead of
// bytes (8 bits/char) buys roughly 18% more payload at the same version.

const ALNUM_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

const ECC_LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
const ECC_FORMAT_BITS = [1, 0, 3, 2]; // L, M, Q, H

// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK = [
  // 0 is unused; index by version 1-40.
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
];

// prettier-ignore
const NUM_ECC_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
];

/** Total number of data+ECC codewords a version can hold. */
function numRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Number of codewords available for data (i.e. excluding error correction). */
function numDataCodewords(version, ecc) {
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecc][version] * NUM_ECC_BLOCKS[ecc][version]
  );
}

function alignmentPatternPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step =
    version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

// --- Bit buffer -------------------------------------------------------------

class BitBuffer {
  constructor() {
    this.bits = [];
  }
  append(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
}

// --- Segments ---------------------------------------------------------------

const MODE_BYTE = { bits: 0x4, ccBits: [8, 16, 16] };
const MODE_ALNUM = { bits: 0x2, ccBits: [9, 11, 13] };
const MODE_NUMERIC = { bits: 0x1, ccBits: [10, 12, 14] };

function charCountBits(mode, version) {
  const i = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  return mode.ccBits[i];
}

function isAlnum(ch) {
  return ALNUM_CHARSET.indexOf(ch) !== -1;
}

function isNumeric(ch) {
  return ch >= '0' && ch <= '9';
}

function makeByteSegment(text) {
  const data = new TextEncoder().encode(text);
  const bb = new BitBuffer();
  for (const b of data) bb.append(b, 8);
  return { mode: MODE_BYTE, numChars: data.length, bits: bb.bits };
}

function makeAlnumSegment(text) {
  const bb = new BitBuffer();
  let i = 0;
  for (; i + 2 <= text.length; i += 2) {
    bb.append(
      ALNUM_CHARSET.indexOf(text[i]) * 45 + ALNUM_CHARSET.indexOf(text[i + 1]),
      11,
    );
  }
  if (i < text.length) bb.append(ALNUM_CHARSET.indexOf(text[i]), 6);
  return { mode: MODE_ALNUM, numChars: text.length, bits: bb.bits };
}

function makeNumericSegment(text) {
  const bb = new BitBuffer();
  for (let i = 0; i < text.length; ) {
    const n = Math.min(3, text.length - i);
    bb.append(parseInt(text.substring(i, i + n), 10), n * 3 + 1);
    i += n;
  }
  return { mode: MODE_NUMERIC, numChars: text.length, bits: bb.bits };
}

/**
 * Split text into segments, switching modes wherever the denser encoding pays
 * for the ~15 bit cost of a mode switch. Greedy rather than optimal, which is
 * within a codeword or two of optimal for link-shaped input.
 */
export function makeSegments(text) {
  const segments = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && isNumeric(text[j])) j++;
    if (j - i >= 7) {
      segments.push(makeNumericSegment(text.substring(i, j)));
      i = j;
      continue;
    }
    j = i;
    while (j < text.length && isAlnum(text[j])) j++;
    if (j - i >= 8) {
      // Long alphanumeric run: worth its own segment.
      segments.push(makeAlnumSegment(text.substring(i, j)));
      i = j;
      continue;
    }
    // Otherwise accumulate bytes until a worthwhile alnum/numeric run starts.
    j = i;
    while (j < text.length) {
      let run = j;
      while (run < text.length && isAlnum(text[run])) run++;
      if (run - j >= 8) break;
      j = Math.max(j + 1, run);
    }
    segments.push(makeByteSegment(text.substring(i, j)));
    i = j;
  }
  return segments.length ? segments : [makeByteSegment('')];
}

function totalBits(segments, version) {
  let total = 0;
  for (const seg of segments) {
    const cc = charCountBits(seg.mode, version);
    if (seg.numChars >= 1 << cc) return Infinity;
    total += 4 + cc + seg.bits.length;
  }
  return total;
}

// --- Reed-Solomon over GF(256), primitive polynomial 0x11D ------------------

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsGeneratorPoly(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, generator) {
  const result = new Uint8Array(generator.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) {
      result[i] ^= gfMultiply(generator[i], factor);
    }
  }
  return result;
}

/** Split data codewords into blocks, append ECC, then interleave. */
function addEccAndInterleave(data, version, ecc) {
  const numBlocks = NUM_ECC_BLOCKS[ecc][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const generator = rsGeneratorPoly(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.subarray(k, k + datLen);
    k += datLen;
    blocks.push({ dat, ecc: rsRemainder(dat, generator), datLen });
  }

  const result = new Uint8Array(rawCodewords);
  let out = 0;
  const maxDatLen = shortBlockLen - blockEccLen + 1;
  for (let i = 0; i < maxDatLen; i++) {
    for (const block of blocks) {
      if (i < block.datLen) result[out++] = block.dat[i];
    }
  }
  for (let i = 0; i < blockEccLen; i++) {
    for (const block of blocks) result[out++] = block.ecc[i];
  }
  return result;
}

// --- Matrix drawing ---------------------------------------------------------

class QrMatrix {
  constructor(version, ecc) {
    this.version = version;
    this.ecc = ecc;
    this.size = version * 4 + 17;
    this.modules = new Uint8Array(this.size * this.size);
    this.isFunction = new Uint8Array(this.size * this.size);
  }
  get(x, y) {
    return this.modules[y * this.size + x];
  }
  set(x, y, dark, functional) {
    this.modules[y * this.size + x] = dark ? 1 : 0;
    if (functional) this.isFunction[y * this.size + x] = 1;
  }
  inBounds(x, y) {
    return x >= 0 && x < this.size && y >= 0 && y < this.size;
  }
}

function drawFinderPattern(m, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx;
      const y = cy + dy;
      if (m.inBounds(x, y)) m.set(x, y, dist !== 2 && dist !== 4, true);
    }
  }
}

function drawAlignmentPattern(m, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      m.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, true);
    }
  }
}

function drawFormatBits(m, mask) {
  const data = (ECC_FORMAT_BITS[m.ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i++) m.set(8, i, (bits >>> i) & 1, true);
  m.set(8, 7, (bits >>> 6) & 1, true);
  m.set(8, 8, (bits >>> 7) & 1, true);
  m.set(7, 8, (bits >>> 8) & 1, true);
  for (let i = 9; i < 15; i++) m.set(14 - i, 8, (bits >>> i) & 1, true);

  for (let i = 0; i < 8; i++) {
    m.set(m.size - 1 - i, 8, (bits >>> i) & 1, true);
  }
  for (let i = 8; i < 15; i++) {
    m.set(8, m.size - 15 + i, (bits >>> i) & 1, true);
  }
  m.set(8, m.size - 8, 1, true); // Always-dark module.
}

function drawFunctionPatterns(m) {
  const size = m.size;
  for (let i = 0; i < size; i++) {
    m.set(6, i, i % 2 === 0, true);
    m.set(i, 6, i % 2 === 0, true);
  }
  drawFinderPattern(m, 3, 3);
  drawFinderPattern(m, size - 4, 3);
  drawFinderPattern(m, 3, size - 4);

  const align = alignmentPatternPositions(m.version);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0);
      if (!corner) drawAlignmentPattern(m, align[i], align[j]);
    }
  }

  if (m.version >= 7) {
    let rem = m.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (m.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.set(a, b, bit, true);
      m.set(b, a, bit, true);
    }
  }

  drawFormatBits(m, 0); // Placeholder; rewritten once the mask is chosen.
}

function drawCodewords(m, data) {
  const size = m.size;
  let i = 0; // Bit index into data.
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // Skip the vertical timing pattern column.
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!m.isFunction[y * size + x] && i < data.length * 8) {
          m.set(x, y, (data[i >>> 3] >>> (7 - (i & 7))) & 1, false);
          i++;
        }
        // Remaining modules past the data stream stay light (already 0).
      }
    }
  }
}

function applyMask(m, mask) {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.isFunction[y * m.size + x]) continue;
      let invert;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: throw new Error('bad mask');
      }
      if (invert) m.modules[y * m.size + x] ^= 1;
    }
  }
}

function penaltyScore(m) {
  const size = m.size;
  let result = 0;
  const N1 = 3, N2 = 3, N3 = 40, N4 = 10;

  const finderPenalty = (runHistory) => {
    const n = runHistory[1];
    const core =
      n > 0 &&
      runHistory[2] === n &&
      runHistory[3] === n * 3 &&
      runHistory[4] === n &&
      runHistory[5] === n;
    return (
      (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
      (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
    );
  };

  for (const horizontal of [true, false]) {
    for (let i = 0; i < size; i++) {
      const runHistory = new Array(7).fill(0);
      let runColor = 0;
      let runLength = 0;
      let padRun = size; // Add white border to initial run.
      for (let j = 0; j < size; j++) {
        const color = horizontal ? m.get(j, i) : m.get(i, j);
        if (color === runColor) {
          runLength++;
          if (runLength === 5) result += N1;
          else if (runLength > 5) result++;
        } else {
          // Push (runLength + padRun) onto the history, then reset.
          runHistory.pop();
          runHistory.unshift(runLength + padRun);
          padRun = 0;
          if (runColor === 0) result += finderPenalty(runHistory) * N3;
          runColor = color;
          runLength = 1;
        }
      }
      runHistory.pop();
      runHistory.unshift(runLength + padRun + (runColor === 1 ? size : 0));
      if (runColor === 1) {
        runHistory.pop();
        runHistory.unshift(0);
      }
      result += finderPenalty(runHistory) * N3;
    }
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m.get(x, y);
      if (c === m.get(x + 1, y) && c === m.get(x, y + 1) && c === m.get(x + 1, y + 1)) {
        result += N2;
      }
    }
  }

  let dark = 0;
  for (const v of m.modules) dark += v;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + k * N4;
}

// --- Public API -------------------------------------------------------------

/**
 * Encode `text` as a QR symbol.
 * @returns {{size:number, modules:Uint8Array, version:number, ecc:string, mask:number}}
 *   `modules` is row-major, 1 = dark. No quiet zone is included.
 */
export function encodeQR(text, options = {}) {
  const {
    ecc = 'M',
    minVersion = 1,
    maxVersion = 40,
    boostEcc = true,
    mask: forcedMask = -1,
  } = options;

  let eccLevel = ECC_LEVELS[ecc];
  if (eccLevel === undefined) throw new Error(`Unknown ECC level: ${ecc}`);

  const segments = makeSegments(text);

  let version = minVersion;
  let dataCapacityBits = 0;
  for (; ; version++) {
    if (version > maxVersion) {
      throw new Error(
        `Data too long for a QR code (${text.length} chars at ECC ${ecc})`,
      );
    }
    dataCapacityBits = numDataCodewords(version, eccLevel) * 8;
    if (totalBits(segments, version) <= dataCapacityBits) break;
  }

  const usedBits = totalBits(segments, version);
  if (boostEcc) {
    for (const candidate of [1, 2, 3]) {
      if (candidate > eccLevel && usedBits <= numDataCodewords(version, candidate) * 8) {
        eccLevel = candidate;
      }
    }
    dataCapacityBits = numDataCodewords(version, eccLevel) * 8;
  }

  // Assemble the bit stream: segment headers, terminator, byte-align, padding.
  const bb = new BitBuffer();
  for (const seg of segments) {
    bb.append(seg.mode.bits, 4);
    bb.append(seg.numChars, charCountBits(seg.mode, version));
    for (const bit of seg.bits) bb.bits.push(bit);
  }
  bb.append(0, Math.min(4, dataCapacityBits - bb.length));
  bb.append(0, (8 - (bb.length % 8)) % 8);
  for (let pad = 0xec; bb.length < dataCapacityBits; pad ^= 0xec ^ 0x11) {
    bb.append(pad, 8);
  }

  const dataCodewords = new Uint8Array(bb.length / 8);
  for (let i = 0; i < bb.length; i++) {
    dataCodewords[i >>> 3] |= bb.bits[i] << (7 - (i & 7));
  }

  const allCodewords = addEccAndInterleave(dataCodewords, version, eccLevel);

  const matrix = new QrMatrix(version, eccLevel);
  drawFunctionPatterns(matrix);
  drawCodewords(matrix, allCodewords);

  let bestMask = forcedMask;
  if (bestMask === -1) {
    let minPenalty = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(matrix, m);
      drawFormatBits(matrix, m);
      const penalty = penaltyScore(matrix);
      if (penalty < minPenalty) {
        minPenalty = penalty;
        bestMask = m;
      }
      applyMask(matrix, m); // Undo (XOR is its own inverse).
    }
  }
  applyMask(matrix, bestMask);
  drawFormatBits(matrix, bestMask);

  return {
    size: matrix.size,
    modules: matrix.modules,
    version,
    ecc: Object.keys(ECC_LEVELS)[eccLevel],
    mask: bestMask,
  };
}

/** Render a QR result as an SVG string. */
export function qrToSvg(qr, { border = 3, dark = '#000', light = 'none', id = '' } = {}) {
  const dim = qr.size + border * 2;
  const parts = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x]) {
        parts.push(`M${x + border},${y + border}h1v1h-1z`);
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges"${id ? ` id="${id}"` : ''}>` +
    (light === 'none' ? '' : `<rect width="${dim}" height="${dim}" fill="${light}"/>`) +
    `<path d="${parts.join('')}" fill="${dark}"/></svg>`
  );
}

/** Draw a QR result into a canvas at the largest crisp integer scale that fits. */
export function qrToCanvas(qr, canvas, { border = 3, dark = '#000', light = '#fff' } = {}) {
  const dim = qr.size + border * 2;
  const dpr = (globalThis.devicePixelRatio || 1);
  const cssSize = canvas.clientWidth || parseInt(canvas.getAttribute('width'), 10) || 256;
  const scale = Math.max(1, Math.floor((cssSize * dpr) / dim));
  const px = dim * scale;
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${px / dpr}px`;
  canvas.style.height = `${px / dpr}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = dark;
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x]) {
        ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
      }
    }
  }
  return { pixels: px, scale };
}

export const _internals = {
  numDataCodewords,
  numRawDataModules,
  alignmentPatternPositions,
  ALNUM_CHARSET,
};
