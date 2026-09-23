import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodePayload,
  decodePayload,
  base32Encode,
  base32Decode,
  buildLink,
  parseLink,
  normalizeReceiver,
} from '../shared/codec.js';

const SAMPLE = {
  url: 'https://example.com/articles/how-qr-codes-work?ref=newsletter',
  title: 'How QR codes work, and why the mask matters',
  selection: 'Reed–Solomon coding is what lets a torn code still scan.',
  fragment: 'Reed%E2%80%93Solomon%20coding%20is%20what,still%20scan.',
  anchor: 'error-correction',
  scroll: 0.42,
  media: { seconds: 91, duration: 600, kind: 'video' },
  from: 'Work laptop',
  sentAt: 1758470400000,
};

test('base32 round-trips arbitrary bytes at every length modulo 5', () => {
  for (let length = 0; length <= 40; length++) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + length) & 0xff;
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes, `length ${length}`);
  }
});

test('base32 decoding is case-insensitive', () => {
  const bytes = new Uint8Array([1, 2, 3, 250, 128, 64]);
  const encoded = base32Encode(bytes);
  assert.deepEqual(base32Decode(encoded.toLowerCase()), bytes);
});

test('base32 rejects characters outside the alphabet', () => {
  assert.throws(() => base32Decode('ABC!DEF'), /Invalid base32/);
});

test('payload round-trips every field', async () => {
  const decoded = await decodePayload(await encodePayload(SAMPLE));
  assert.deepEqual(decoded, SAMPLE);
});

test('payload survives non-Latin text and emoji', async () => {
  const state = {
    url: 'https://ja.wikipedia.org/wiki/QRコード',
    title: 'QRコード — 📱 から 💻 へ',
    selection: 'デンソーウェーブが開発した二次元コード。',
  };
  assert.deepEqual(await decodePayload(await encodePayload(state)), state);
});

test('payload is uppercase base32 so it stays in the QR alphanumeric charset', async () => {
  const payload = await encodePayload(SAMPLE);
  assert.match(payload, /^P[A-Z2-7]+$/);
});

test('compression actually earns its place on realistic input', async () => {
  const wordy = {
    url: 'https://example.com/a/rather/long/path/to/an/article/about/things',
    title: 'A rather long title about rather long titles and their consequences',
    selection: 'the same words repeated '.repeat(12),
  };
  const packedLength = (await encodePayload(wordy)).length;
  const rawLength = Math.ceil((JSON.stringify(wordy).length + 1) * 1.6);
  assert.ok(
    packedLength < rawLength * 0.7,
    `expected compression to help: ${packedLength} vs ${rawLength} uncompressed`,
  );
});

test('links carry the payload in the fragment, which never reaches a server', async () => {
  const link = await buildLink(SAMPLE, 'https://passit.example.com');
  const [base, hash] = link.split('#');
  assert.equal(base, 'https://passit.example.com/');
  assert.match(hash, /^P[A-Z2-7]+$/);
  assert.deepEqual(await parseLink(link), SAMPLE);
});

test('buildLink tolerates receivers with or without a trailing slash or hash', async () => {
  for (const receiver of [
    'https://p.example.com',
    'https://p.example.com/',
    'https://p.example.com/#stale',
  ]) {
    const link = await buildLink(SAMPLE, receiver);
    assert.ok(link.startsWith('https://p.example.com/#P'), link.slice(0, 40));
  }
});

test('buildLink does not turn a receiver file into a directory', async () => {
  // Appending a slash here would make every relative import on the receiver
  // page resolve one level too deep, and the page would silently not boot.
  for (const receiver of [
    'https://p.example.com/passit/index.html',
    'file:///srv/passit/index.html',
    'https://p.example.com/passit',
  ]) {
    const link = await buildLink(SAMPLE, receiver);
    assert.equal(link.split('#')[0], receiver, `receiver was rewritten: ${link.split('#')[0]}`);
  }
});

test('normalizeReceiver rejects something that is not a URL', () => {
  assert.throws(() => normalizeReceiver('passit.example.com'), /Invalid URL/);
});

test('decoding is forgiving about how the payload was pasted', async () => {
  const payload = await encodePayload({ url: 'https://example.com/' });
  for (const variant of [payload, `#${payload}`, payload.toLowerCase(), ` ${payload} `]) {
    assert.equal((await decodePayload(variant)).url, 'https://example.com/');
  }
});

test('a corrupt payload fails with a message rather than a stack trace', async () => {
  await assert.rejects(decodePayload(''), /Empty payload/);
  await assert.rejects(decodePayload('P'), /Empty payload/);
  await assert.rejects(
    decodePayload(`P${base32Encode(new Uint8Array([1]))}`),
    /too short/i,
  );
  // Header claims a format version this build does not know.
  await assert.rejects(decodePayload(`P${base32Encode(new Uint8Array([9, 1, 2]))}`), /version 9/);
});

test('a payload without a URL is rejected', async () => {
  const body = new TextEncoder().encode(JSON.stringify({ t: 'no url here' }));
  const bytes = new Uint8Array([1, ...body]);
  await assert.rejects(decodePayload(`P${base32Encode(bytes)}`), /missing a URL/);
});
