// Fitting a handoff into a QR code that a camera can actually read.
//
// The QR standard tops out at version 40 (177×177 modules), but a symbol that
// dense will not scan from a laptop screen at arm's length. PassIt caps the
// version and, when a state does not fit, drops the least important parts in
// a fixed order — saying which — rather than failing outright or truncating
// something silently.

import { buildLink, normalizeReceiver } from './codec.js';
import { encodeQR } from './qr.js';
import { encodeFragmentText } from './target.js';

/** Version 25 is 117 modules: crisp at 2 CSS px per module in a 300 px popup. */
export const DEFAULT_MAX_VERSION = 25;

/** Words kept on each side when a text directive has to be shortened. */
const SHORT_EDGE_WORDS = 4;

function fitError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function withoutKey(state, key) {
  const copy = { ...state };
  delete copy[key];
  return copy;
}

function decodePart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/**
 * A shorter form of a text directive value, or null when it cannot be
 * shortened. `prefix-,` and `,-suffix` are kept: they are what makes the
 * directive land in the right place. Only the highlighted span shrinks.
 */
export function shortenDirective(fragment) {
  const parts = String(fragment).split(',');
  const prefix = parts.length > 1 && parts[0].endsWith('-') ? parts.shift() : '';
  const suffix = parts.length > 1 && parts[parts.length - 1].startsWith('-') ? parts.pop() : '';
  if (parts.length === 0 || parts.length > 2) return null;

  const start = decodePart(parts[0]);
  const end = parts.length === 2 ? decodePart(parts[1]) : '';
  if (start === null || end === null) return null;

  const startWords = start.split(' ').filter(Boolean);
  const endWords = end.split(' ').filter(Boolean);

  let shortStart;
  let shortEnd;
  if (end) {
    shortStart = startWords.slice(0, SHORT_EDGE_WORDS);
    shortEnd = endWords.slice(-SHORT_EDGE_WORDS);
  } else if (startWords.length >= SHORT_EDGE_WORDS * 2 + 1) {
    // A whole phrase long enough to split without the two halves overlapping.
    shortStart = startWords.slice(0, SHORT_EDGE_WORDS);
    shortEnd = endWords.concat(startWords.slice(-SHORT_EDGE_WORDS));
  } else {
    return null;
  }

  const rebuilt =
    [prefix, encodeFragmentText(shortStart.join(' '))].filter(Boolean).join(',') +
    (shortEnd.length ? `,${encodeFragmentText(shortEnd.join(' '))}` : '') +
    (suffix ? `,${suffix}` : '');
  return rebuilt.length < String(fragment).length ? rebuilt : null;
}

/**
 * What to give up, in order, when a handoff does not fit. Each step returns a
 * smaller state or null when it has nothing to remove.
 */
const TRIM_STEPS = [
  ['note', (state) => (state.note ? withoutKey(state, 'note') : null)],
  ['selection', (state) => (state.selection ? withoutKey(state, 'selection') : null)],
  [
    'fragment length',
    (state) => {
      const shorter = state.fragment ? shortenDirective(state.fragment) : null;
      return shorter ? { ...state, fragment: shorter } : null;
    },
  ],
  ['fragment', (state) => (state.fragment ? withoutKey(state, 'fragment') : null)],
  [
    'title',
    (state) =>
      state.title && state.title.length > 60
        ? { ...state, title: `${state.title.slice(0, 57).trimEnd()}…` }
        : null,
  ],
];

/**
 * Encode a state into a link and a QR symbol no larger than `maxVersion`,
 * trimming the state if it has to.
 *
 * @returns {Promise<{link: string, qr: object, state: object, trimmed: string[]}>}
 *   `trimmed` names what was dropped, in order, so the UI can say so.
 * @throws an Error with `code` 'receiver' (the receiver setting is not a URL)
 *   or 'size' (nothing left to trim and it still does not fit).
 */
export async function encodeHandoff(
  state,
  receiver,
  { ecc = 'M', maxVersion = DEFAULT_MAX_VERSION } = {},
) {
  let base;
  try {
    base = normalizeReceiver(receiver);
  } catch {
    throw fitError(
      'receiver',
      `The receiver address “${receiver}” is not a valid URL. Set it in settings.`,
    );
  }

  const steps = TRIM_STEPS.slice();
  const trimmed = [];
  let current = { ...state };

  for (;;) {
    const link = await buildLink(current, base);
    try {
      const qr = encodeQR(link, { ecc, maxVersion });
      return { link, qr, state: current, trimmed };
    } catch (error) {
      if (error.code !== 'QR_TOO_LONG') throw error;
    }

    let next = null;
    while (steps.length && !next) {
      const [name, apply] = steps.shift();
      next = apply(current);
      if (next) trimmed.push(name);
    }
    if (!next) {
      throw fitError(
        'size',
        `Even with everything but the address removed, this needs a QR code larger ` +
          `than version ${maxVersion}. The page address alone is ${current.url.length} characters.`,
      );
    }
    current = next;
  }
}
