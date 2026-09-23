// End-to-end capture and restore in a real browser engine.
//
// The parts of PassIt that can go quietly wrong — picking the paragraph the
// reader is actually looking at, skipping the sticky header, producing a text
// fragment the browser will honour — cannot be checked without layout. These
// tests drive WKWebView through `tools/run-page.swift`, capture from a fixture
// article, and then load the resulting link back to see where the page lands.
//
// WebKit rather than Chromium because it is the engine most receiving phones
// will be running, and because it needs no listening socket to start.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER = join(ROOT, 'tools', 'run-page.swift');
const FIXTURE = pathToFileURL(join(ROOT, 'test', 'fixtures', 'article.html')).href;

function webkitAvailable() {
  try {
    execFileSync('swift', ['--version'], { stdio: 'ignore' });
    return process.platform === 'darwin';
  } catch {
    return false;
  }
}

const skip = webkitAvailable() ? false : 'WKWebView driver needs macOS with swift';

/** Load a URL in WKWebView and return the parsed JSON text of one element. */
function load(url, selector, settleMs = 300) {
  const stdout = execFileSync('swift', [DRIVER, url, selector, ROOT, String(settleMs)], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(stdout);
}

const capture = (query) => load(`${FIXTURE}?${query}`, '#report');

/**
 * Reload a captured target with the fixture's own scrolling switched off, so
 * the text fragment is the only thing that can move the page.
 */
function restore(target, expect) {
  const [base, hash] = target.split('#');
  const query = base.replace(/\?s=[\d.]+/, '?s=0');
  // 1.5s of settle before reading: the fragment scroll has to have happened.
  return load(`${query}&expect=${expect}#${hash}`, '#scroll', 1500);
}

test('capture and restore in WebKit', { skip, concurrency: false }, async (t) => {
  // ── Scrolled two thirds down, nothing selected ──────────────────────────
  const scrolled = capture('s=0.66');

  await t.test('captures the page identity and position', () => {
    assert.match(scrolled.state.url, /article\.html\?s=0\.66$/);
    assert.equal(scrolled.state.title, 'Fixture: a long article');
    assert.ok(
      scrolled.state.scroll > 0.6 && scrolled.state.scroll < 0.72,
      `scroll was ${scrolled.state.scroll}`,
    );
  });

  await t.test('anchors to text the reader can see, not the sticky header', () => {
    assert.ok(scrolled.state.fragment, 'no text fragment was captured');
    const text = decodeURIComponent(scrolled.state.fragment.split(',')[0]);
    assert.ok(!text.includes('Sticky navigation'), `captured the sticky header: ${text}`);
    assert.match(text, /^Paragraph \d+\./, `unexpected anchor text: ${text}`);
  });

  await t.test('keeps an element id as a fallback for the text fragment', () => {
    assert.match(scrolled.state.anchor, /^para-\d+$/);
    assert.match(scrolled.target, /#para-\d+:~:text=/);
  });

  await t.test('survives the round trip through the link', () => {
    assert.deepEqual(scrolled.decoded, scrolled.trimmed);
    assert.ok(
      scrolled.payloadLength < 450,
      `payload was ${scrolled.payloadLength} characters, which makes for a dense QR`,
    );
  });

  await t.test('the browser really lands on the paragraph that was on screen', () => {
    const paragraph = Number(/para-(\d+)/.exec(scrolled.state.anchor)[1]);
    const landed = restore(scrolled.target, paragraph);

    assert.ok(landed.scrollY > 0, 'the page did not scroll at all');
    // The engine strips the fragment directive and leaves the plain anchor,
    // which is exactly the graceful degradation the anchor is there for.
    assert.equal(landed.hash, `#para-${paragraph}`);
    assert.ok(
      landed.visible[paragraph].onScreen,
      `paragraph ${paragraph} was ${landed.visible[paragraph].top}px off screen`,
    );
  });

  // ── With a selection ────────────────────────────────────────────────────
  const selected = capture('s=0.3&sel=22');

  await t.test('a selection is carried across and takes priority over the viewport', () => {
    assert.match(selected.state.selection, /^Paragraph 22\./);
    const text = decodeURIComponent(selected.state.fragment.split(',')[0]);
    assert.match(text, /^Paragraph 22\./, `fragment ignored the selection: ${text}`);
  });

  await t.test('dropping the selection falls back to the viewport anchor', () => {
    const without = selected.withoutSelection;
    assert.equal(without.selection, undefined);
    assert.ok(without.fragment, 'no fallback anchor was kept');
    assert.notEqual(without.fragment, selected.state.fragment);
    assert.equal(without.viewportFragment, undefined, 'capture internals leaked into the payload');
  });

  await t.test('dropping position leaves a plain link', () => {
    const without = selected.withoutPosition;
    for (const key of ['fragment', 'anchor', 'scroll', 'media']) {
      assert.equal(without[key], undefined, `${key} should have been dropped`);
    }
    assert.equal(without.selection, selected.state.selection);
  });

  // ── The ambiguous paragraph ─────────────────────────────────────────────
  await t.test('a paragraph that appears twice still lands on the right copy', () => {
    // Paragraph 48 is a verbatim copy of paragraph 5, so a text fragment built
    // naively from its text would scroll the reader back to paragraph 5.
    const duplicate = capture('s=0&sel=48');
    assert.equal(duplicate.state.selection, duplicate.duplicated);

    const landed = restore(duplicate.target, '48,5');
    assert.ok(landed.visible['48'].onScreen, 'the second copy is not on screen');
    assert.ok(!landed.visible['5'].onScreen, 'scrolled to the first copy instead');
  });
});
