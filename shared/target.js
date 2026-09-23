// Turning captured state back into a URL the receiving browser will honour.
//
// The hard part of a handoff is restoring *position* on a page you do not
// control. You cannot inject script into a third-party site from a phone, so
// PassIt leans on a platform feature instead: text fragments
// (`#:~:text=...`), supported by Chrome, Edge, Safari 16.1+ and Firefox 131+.
// The sender records a distinctive snippet of the text that was on screen; the
// receiver navigates to it and the browser scrolls there and highlights it.
//
// Fallbacks, in order: an element id near the viewport top, then a plain scroll
// percentage the receiver shows as a hint.

/** Characters a text fragment must percent-encode beyond the usual set. */
function encodeFragmentText(text) {
  return encodeURIComponent(text)
    .replace(/-/g, '%2D')
    .replace(/,/g, '%2C')
    .replace(/&/g, '%26');
}

/** Collapse whitespace; text fragment matching is whitespace-insensitive but
 *  shorter is better for QR density. */
export function normalizeSnippet(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function words(text) {
  return normalizeSnippet(text).split(' ').filter(Boolean);
}

/**
 * Build the value of a `text=` directive for a snippet (no `text=` prefix).
 *
 * Short snippets are matched whole. Long ones use the spec's `start,end` form
 * so the whole passage is highlighted without paying for it in QR bytes.
 */
export function makeTextDirective(
  snippet,
  { maxWholeChars = 70, edgeWords = 6, prefix = '' } = {},
) {
  const clean = normalizeSnippet(snippet);
  if (clean.length < 8) return null;

  const head = prefix ? `${encodeFragmentText(normalizeSnippet(prefix))}-,` : '';

  if (clean.length <= maxWholeChars) {
    return head + encodeFragmentText(clean);
  }

  const parts = words(clean);
  if (parts.length <= edgeWords * 2) {
    return head + encodeFragmentText(clean);
  }
  const start = parts.slice(0, edgeWords).join(' ');
  const end = parts.slice(-edgeWords).join(' ');
  return `${head}${encodeFragmentText(start)},${encodeFragmentText(end)}`;
}

/** Remove any fragment directive already present, so we can add our own. */
export function stripFragmentDirective(url) {
  return String(url).replace(/:~:.*$/, '');
}

/** Split a URL into [everythingBeforeHash, hashWithoutHashChar]. */
function splitHash(url) {
  const index = url.indexOf('#');
  if (index === -1) return [url, ''];
  return [url.slice(0, index), url.slice(index + 1)];
}

/**
 * YouTube resumes from a `t` query parameter. Other sites get no automatic
 * seek — the receiver surfaces the timestamp instead of guessing.
 */
export function applyMediaTime(url, media) {
  if (!media || !media.seconds || media.seconds < 5) return url;
  const seconds = Math.floor(media.seconds);
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
      parsed.searchParams.set('t', `${seconds}`);
      return parsed.toString();
    }
  } catch {
    /* Not parseable; leave it alone. */
  }
  return url;
}

/**
 * The URL to actually open on the receiving device.
 * @param {object} state captured page state
 * @param {object} [options]
 * @param {boolean} [options.position] include the text fragment / anchor
 * @param {boolean} [options.media] include a media timestamp
 */
export function buildTargetUrl(state, { position = true, media = true } = {}) {
  let url = stripFragmentDirective(state.url);
  if (media) url = applyMediaTime(url, state.media);
  if (!position) return url;

  const [base, hash] = splitHash(url);
  const directive = state.fragment ? `text=${state.fragment}` : null;

  if (directive) {
    // The fragment directive always goes last, after any existing fragment id.
    const keepHash = hash || state.anchor || '';
    return `${base}#${keepHash}:~:${directive}`;
  }
  if (state.anchor && !hash) return `${base}#${state.anchor}`;
  return url;
}

/**
 * True when the receiving browser is expected to honour a text fragment.
 * Used only to decide whether to show the "scroll to ~42%" hint instead.
 */
export function supportsTextFragments(nav = globalThis.navigator) {
  if (typeof document !== 'undefined' && 'fragmentDirective' in document) return true;
  const ua = nav?.userAgent || '';
  const safari = /Version\/(\d+)[\d.]*\s+(Mobile\/\S+\s+)?Safari/.exec(ua);
  if (safari) return Number(safari[1]) >= 16;
  return false;
}

export function formatScroll(scroll) {
  if (typeof scroll !== 'number' || !isFinite(scroll)) return null;
  const pct = Math.round(scroll * 100);
  if (pct <= 1) return 'top of page';
  if (pct >= 99) return 'bottom of page';
  return `${pct}% down`;
}

export function formatDuration(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
