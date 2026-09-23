// Capturing what "where I am on this page" actually means.
//
// This module runs inside the page (injected by the extension, or inlined into
// the bookmarklet), so it stays free of imports at runtime — the build
// concatenates it with target.js. Keep everything it needs inside these
// functions.

import { makeTextDirective, normalizeSnippet, stripFragmentDirective } from './target.js';

const MAX_SELECTION_CHARS = 400;
const SNIPPET_LENGTHS = [120, 200, 280];
const PREFIX_LOOKBEHIND = 240;

function isHiddenOrChrome(el) {
  // Skip sticky headers, cookie banners and anything not actually rendered:
  // they sit at the top of the viewport but are not where the reader is.
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') return true;
    if (Number(style.opacity) === 0) return true;
    if (style.position === 'fixed' || style.position === 'sticky') return true;
  }
  return false;
}

function rectOf(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  range.detach?.();
  return rect;
}

/** Walk the text nodes inside `root`, in document order. */
function* textNodesIn(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || node.nodeValue.trim().length < 12) {
        return NodeFilter.FILTER_REJECT;
      }
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  let budget = 4000; // Bound the walk on pathological documents.
  while ((node = walker.nextNode()) && budget-- > 0) yield node;
}

/**
 * Find the first substantial text node at or below the top of the viewport.
 *
 * Probing with elementFromPoint first keeps this cheap on large documents: we
 * only tree-walk inside the handful of elements actually under the reader's
 * eye, rather than the whole page.
 */
function findViewportTextNode() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const xs = [vw * 0.5, vw * 0.3, vw * 0.7, vw * 0.15];
  const step = Math.max(16, Math.round(vh * 0.04));
  const seen = new Set();

  for (let y = 8; y < vh * 0.9; y += step) {
    for (const x of xs) {
      const el = document.elementFromPoint(x, y);
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (isHiddenOrChrome(el)) continue;

      for (const node of textNodesIn(el)) {
        const rect = rectOf(node);
        if (rect.height === 0 || rect.width === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        return node;
      }
    }
  }

  // Nothing under the probe points (canvas app, image gallery): fall back to a
  // full walk and take the first node inside the viewport.
  for (const node of textNodesIn(document.body)) {
    const rect = rectOf(node);
    if (rect.height > 0 && rect.bottom > 0 && rect.top < vh) return node;
  }
  return null;
}

/** Text preceding `node` in the same block, used to disambiguate a snippet. */
/**
 * The rendered text immediately before `node`, in document order.
 *
 * Walking the text nodes backwards rather than reading the parent block is
 * what makes this work for the common case, where the node *is* its whole
 * paragraph and everything before it lives in an earlier element.
 */
function precedingText(node, limit) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  walker.currentNode = node;

  let collected = '';
  let previous;
  let budget = 200;
  while (collected.length < limit * 2 && budget-- > 0 && (previous = walker.previousNode())) {
    const tag = previous.parentElement?.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
    collected = `${previous.nodeValue || ''} ${collected}`;
  }
  return normalizeSnippet(collected).slice(-limit);
}

/**
 * The text node a selection starts in.
 *
 * `anchorNode` is an element whenever the selection was made with
 * `selectNodeContents` or by triple-clicking a paragraph, and an element has
 * no text of its own to anchor against.
 */
function selectionTextNode(selection) {
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  let node = range.startContainer;
  if (node.nodeType === Node.ELEMENT_NODE) {
    node = node.childNodes[range.startOffset] || node.firstChild || node;
  }
  while (node && node.nodeType !== Node.TEXT_NODE) node = node.firstChild;
  return node;
}

function truncateAtWord(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).trim();
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (count < 3) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count++;
    from = at + 1;
  }
  return count;
}

/**
 * Turn a snippet into a text-fragment directive that lands in the right place.
 *
 * A text fragment scrolls to the *first* match, so a snippet that repeats
 * earlier on the page would send the reader backwards. Lengthen the snippet
 * until it is unique; failing that, pin it with a `prefix-` taken from the
 * text before it, grown a few words at a time until the pair is unambiguous.
 */
function buildFragment(snippet, { node = null, pageText = '' } = {}) {
  const clean = normalizeSnippet(snippet);
  if (clean.length < 12) return null;

  let candidate = '';
  for (const limit of SNIPPET_LENGTHS) {
    const attempt = truncateAtWord(clean, limit);
    if (attempt.length < 12) continue;
    candidate = attempt;
    if (!pageText || countOccurrences(pageText, candidate) <= 1) {
      return makeTextDirective(candidate);
    }
    if (candidate.length >= clean.length) break;
  }
  if (!candidate) return null;

  if (node && pageText) {
    const words = precedingText(node, PREFIX_LOOKBEHIND).split(' ').filter(Boolean);
    for (let count = 4; count <= words.length; count += 4) {
      const prefix = words.slice(-count).join(' ');
      if (countOccurrences(pageText, `${prefix} ${candidate}`) === 1) {
        return makeTextDirective(candidate, { prefix });
      }
    }
  }

  // Genuinely indistinguishable from an earlier passage. The fragment will
  // land on the first copy, which is still closer than not scrolling at all.
  return makeTextDirective(candidate);
}

function nearestAnchorId(node) {
  const start = node?.parentElement || document.body;
  for (let el = start; el && el !== document.documentElement; el = el.parentElement) {
    const id = el.id;
    // Framework-generated ids (`:r3:`, `react-aria-9`) are not stable across
    // loads, so they are worse than nothing as a scroll target.
    if (id && /^[A-Za-z][\w.:-]{0,60}$/.test(id) && !/^(react|radix|headlessui|:)/i.test(id)) {
      return id;
    }
  }
  return null;
}

function captureScroll() {
  const el = document.scrollingElement || document.documentElement;
  const max = el.scrollHeight - window.innerHeight;
  if (max <= 4) return null;
  return Math.min(1, Math.max(0, window.scrollY / max));
}

function captureMedia() {
  const players = document.querySelectorAll('video, audio');
  for (const player of players) {
    if (!player.currentTime || player.currentTime < 5) continue;
    if (player.currentTime < 1) continue;
    const rect = player.getBoundingClientRect?.();
    if (rect && rect.width === 0 && rect.height === 0 && player.paused) continue;
    return {
      seconds: Math.round(player.currentTime),
      duration: isFinite(player.duration) ? Math.round(player.duration) : undefined,
      kind: player.tagName.toLowerCase(),
    };
  }
  return null;
}

/**
 * Capture the current tab's readable state.
 *
 * Both the selection-based and viewport-based anchors are returned so the UI
 * can toggle "include my selection" without re-running capture — by then the
 * user has clicked into the popup and the page's selection may be gone.
 *
 * @param {object} [options]
 * @param {boolean} [options.position] capture scroll position / text anchor
 * @param {boolean} [options.selection] include selected text
 * @param {string}  [options.from] label for the sending device
 * @returns {object} state, ready for `encodePayload`
 */
export function capturePageState(options = {}) {
  const { position = true, selection: wantSelection = true, from = '' } = options;

  const state = {
    url: stripFragmentDirective(location.href),
    title: normalizeSnippet(document.title).slice(0, 160),
    sentAt: Date.now(),
  };
  if (from) state.from = from;

  const liveSelection = wantSelection ? window.getSelection?.() : null;
  const selected = normalizeSnippet(liveSelection?.toString() || '');
  if (selected.length >= 2) {
    state.selection = truncateAtWord(selected, MAX_SELECTION_CHARS);
  }

  if (!position) return state;

  const scroll = captureScroll();
  if (scroll !== null) state.scroll = Math.round(scroll * 1000) / 1000;

  const media = captureMedia();
  if (media) state.media = media;

  // The corpus the browser will search when it honours the fragment is the
  // page's *rendered* text, so uniqueness has to be judged against innerText —
  // textContent would include script bodies and hidden markup and give the
  // wrong answer. Capped so a giant log viewer does not stall the popup.
  const pageText = normalizeSnippet(
    (document.body?.innerText || document.body?.textContent || '').slice(0, 400000),
  );

  const viewportNode = findViewportTextNode();
  const viewportFragment = viewportNode
    ? buildFragment(viewportNode.nodeValue, { node: viewportNode, pageText })
    : null;
  if (viewportFragment) state.viewportFragment = viewportFragment;

  // An explicit selection is the strongest possible signal of intent.
  const selectionNode = selectionTextNode(liveSelection);
  const selectionFragment =
    selected.length >= 12
      ? buildFragment(selected, { node: selectionNode, pageText })
      : null;

  const fragment = selectionFragment || viewportFragment;
  if (fragment) state.fragment = fragment;

  const id = nearestAnchorId(selectionFragment ? selectionNode : viewportNode);
  if (id) state.anchor = id;

  return state;
}

/**
 * Narrow a captured state down to what the sender chose to include.
 *
 * Pure, so it runs in the popup rather than the page — turning "include my
 * selection" off must not require going back to a tab whose selection has
 * since been cleared by the click.
 */
export function applyCaptureOptions(state, { position = true, selection = true } = {}) {
  const out = { ...state };

  if (!selection) {
    delete out.selection;
    if (out.viewportFragment) out.fragment = out.viewportFragment;
    else delete out.fragment;
  }
  if (!position) {
    delete out.fragment;
    delete out.anchor;
    delete out.scroll;
    delete out.media;
  }

  delete out.viewportFragment;
  return out;
}
