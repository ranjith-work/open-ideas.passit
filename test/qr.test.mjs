import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQR, makeSegments, _internals } from '../shared/qr.js';
import { encodePayload } from '../shared/codec.js';
import { decodeWithVision, swiftAvailable } from './vision.mjs';

test('capacity table matches the published totals for a few known versions', () => {
  // Spot checks against ISO/IEC 18004 Table 7.
  assert.equal(_internals.numDataCodewords(1, 0), 19); // 1-L
  assert.equal(_internals.numDataCodewords(1, 3), 9); // 1-H
  assert.equal(_internals.numDataCodewords(10, 1), 216); // 10-M
  assert.equal(_internals.numDataCodewords(40, 0), 2956); // 40-L
  assert.equal(_internals.numDataCodewords(40, 3), 1276); // 40-H
});

test('alignment pattern positions match the standard', () => {
  assert.deepEqual(_internals.alignmentPatternPositions(1), []);
  assert.deepEqual(_internals.alignmentPatternPositions(7), [6, 22, 38]);
  assert.deepEqual(_internals.alignmentPatternPositions(32), [6, 34, 60, 86, 112, 138]);
});

test('a long base32 run is encoded as alphanumeric, not bytes', () => {
  const link = `https://passit.example.com/#P${'ABCDEFGHIJKLMNOP234567'.repeat(8)}`;
  const segments = makeSegments(link);
  assert.equal(segments.length, 2, 'expected a byte prefix then an alphanumeric payload');
  assert.equal(segments[0].mode.bits, 0x4, 'prefix should be byte mode');
  assert.equal(segments[1].mode.bits, 0x2, 'payload should be alphanumeric mode');
});

test('alphanumeric segmentation buys a smaller symbol than plain bytes would', () => {
  const payload = 'ABCDEFGHIJKLMNOP234567'.repeat(10);
  const alnum = encodeQR(`https://passit.example.com/#P${payload}`, { ecc: 'M' });
  // Same byte count, but lowercase forces byte mode throughout.
  const bytes = encodeQR(`https://passit.example.com/#P${payload.toLowerCase()}`, { ecc: 'M' });
  assert.ok(
    alnum.version < bytes.version,
    `alphanumeric ${alnum.version} should beat byte ${bytes.version}`,
  );
});

test('error correction is boosted for free when the version has room', () => {
  const qr = encodeQR('short', { ecc: 'L' });
  assert.equal(qr.ecc, 'H', 'a tiny payload should end up at the strongest level');
});

test('mask selection is not stuck on one pattern', () => {
  const chosen = new Set();
  for (let i = 0; i < 24; i++) {
    chosen.add(encodeQR(`https://example.com/page/${i}/${'x'.repeat(i * 3)}`).mask);
  }
  assert.ok(chosen.size >= 3, `expected varied masks, saw ${[...chosen].join(',')}`);
});

test('data beyond version 40 is refused clearly', () => {
  assert.throws(() => encodeQR('x'.repeat(3000), { ecc: 'H' }), /too long/i);
});

test('a realistic handoff fits in a comfortably scannable symbol', async () => {
  const payload = await encodePayload({
    url: 'https://www.nytimes.com/2026/03/14/science/quantum-error-correction.html',
    title: 'The Quiet Revolution in Quantum Error Correction',
    selection:
      'The surface code needs thousands of physical qubits to protect a single ' +
      'logical one, which is why the engineering problem has outrun the physics.',
    fragment: 'The%20surface%20code%20needs%20thousands%20of,outrun%20the%20physics.',
    scroll: 0.63,
    sentAt: Date.now(),
    from: 'Work laptop',
  });
  const qr = encodeQR(`https://passit.example.com/#${payload}`, { ecc: 'M' });
  // Version 15 is about 77 modules: still crisp on a laptop screen from arm's
  // length, which is the whole ergonomic point.
  assert.ok(qr.version <= 15, `handoff needed version ${qr.version}`);
});

test(
  'symbols decode in a real QR reader',
  { skip: swiftAvailable() ? false : 'swift/Vision not available' },
  async () => {
    const link = `https://passit.example.com/#${await encodePayload({
      url: 'https://example.com/a/very/ordinary/article',
      title: 'An ordinary article',
      selection: 'a sentence someone wanted to keep hold of',
      scroll: 0.5,
    })}`;

    const cases = [
      { text: 'PASSIT' },
      { text: link },
      { text: link, options: { ecc: 'H' } },
      { text: 'https://example.com/#' + 'A'.repeat(1200), options: { ecc: 'L' } },
      { text: 'café ☕ naïve 日本語 — mixed scripts and punctuation' },
    ];

    const results = decodeWithVision(cases);
    assert.equal(results.length, cases.length);
    results.forEach((result, index) => {
      assert.ok(result.ok, `case ${index} was not detected at all`);
      assert.equal(result.payload, cases[index].text, `case ${index} decoded differently`);
    });
  },
);
