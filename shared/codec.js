// Payload codec: browser state <-> a self-contained link.
//
// PassIt has no server. Everything about a handoff travels inside the link that
// the QR encodes, which means a handoff is as private as the two screens
// involved and works on a plane with the wifi off.
//
// Wire format, after the `#` of the receiver URL:
//
//   P<base32( header byte | body )>
//
//   header bit 0..3 : format version (currently 1)
//   header bit 7    : body is raw-deflate compressed
//   body            : UTF-8 JSON, keys shortened (see PACK_KEYS)
//
// base32 rather than base64url because RFC 4648's alphabet is a subset of the
// QR alphanumeric charset, which costs 5.5 bits/char instead of 8 — about 18%
// more payload in the same symbol. Decoding accepts either case.

const FORMAT_VERSION = 1;
const COMPRESSED_FLAG = 0x80;
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Long name -> short key. Shrinks the JSON before deflate even sees it. */
const PACK_KEYS = {
  url: 'u',
  title: 't',
  selection: 's',
  fragment: 'f',
  anchor: 'a',
  scroll: 'y',
  media: 'm',
  from: 'd',
  sentAt: 'w',
  note: 'n',
};
const UNPACK_KEYS = Object.fromEntries(
  Object.entries(PACK_KEYS).map(([k, v]) => [v, k]),
);

export function base32Encode(bytes) {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = B32_ALPHABET.indexOf(ch);
    if (value === -1) throw new Error(`Invalid base32 character: ${ch}`);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

async function streamThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const canCompress = typeof CompressionStream !== 'undefined';

async function deflate(bytes) {
  if (!canCompress) return null;
  try {
    return await streamThrough(bytes, new CompressionStream('deflate-raw'));
  } catch {
    return null;
  }
}

async function inflate(bytes) {
  return streamThrough(bytes, new DecompressionStream('deflate-raw'));
}

function pack(state) {
  const packed = {};
  for (const [long, short] of Object.entries(PACK_KEYS)) {
    const value = state[long];
    if (value === undefined || value === null || value === '') continue;
    packed[short] = value;
  }
  return packed;
}

function unpack(packed) {
  const state = {};
  for (const [short, value] of Object.entries(packed)) {
    state[UNPACK_KEYS[short] ?? short] = value;
  }
  return state;
}

/** Encode state into the fragment payload (no leading `#`). */
export async function encodePayload(state) {
  const json = new TextEncoder().encode(JSON.stringify(pack(state)));
  const compressed = await deflate(json);
  // Deflate can lose on very short inputs; keep whichever is smaller.
  const useCompressed = compressed !== null && compressed.length < json.length;
  const body = useCompressed ? compressed : json;
  const out = new Uint8Array(body.length + 1);
  out[0] = FORMAT_VERSION | (useCompressed ? COMPRESSED_FLAG : 0);
  out.set(body, 1);
  return 'P' + base32Encode(out);
}

/** Decode a fragment payload (with or without the leading `#` or `P`). */
export async function decodePayload(fragment) {
  let text = String(fragment || '').trim();
  if (text.startsWith('#')) text = text.slice(1);
  if (/^p/i.test(text)) text = text.slice(1);
  if (!text) throw new Error('Empty payload');

  const bytes = base32Decode(text);
  if (bytes.length < 2) throw new Error('Payload too short');
  const header = bytes[0];
  const version = header & 0x0f;
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported PassIt payload version ${version}`);
  }
  let body = bytes.subarray(1);
  if (header & COMPRESSED_FLAG) body = await inflate(body);
  const state = unpack(JSON.parse(new TextDecoder().decode(body)));
  if (typeof state.url !== 'string' || !state.url) {
    throw new Error('Payload is missing a URL');
  }
  return state;
}

/**
 * Build the link a QR should encode.
 *
 * `receiver` is the static PassIt page; it never sees the payload, because the
 * fragment is not sent to servers.
 */
export async function buildLink(state, receiver) {
  const payload = await encodePayload(state);
  return `${normalizeReceiver(receiver)}#${payload}`;
}

/**
 * Canonicalise a receiver URL: drop any stale fragment, and let the URL parser
 * supply the trailing slash for a bare origin.
 *
 * Doing this by hand is a trap. `https://example.com` does need a slash
 * appended, but `https://example.com/passit/index.html` emphatically does not
 * — a slash there turns the page into a directory and every relative import
 * on it resolves one level too deep.
 */
export function normalizeReceiver(receiver) {
  const url = new URL(String(receiver).trim());
  url.hash = '';
  return url.href;
}

export function parseLink(link) {
  const hash = String(link).split('#').slice(1).join('#');
  return decodePayload(hash);
}
