// The receiving side, exercised as a real page in a real engine.
//
// These run against `dist/web`, so they cover the built artefact a phone would
// actually load — including the generated bookmarklet module, which only
// exists after a build.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildLink } from '../shared/codec.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER = join(ROOT, 'tools', 'run-page.swift');
const RECEIVER = pathToFileURL(join(ROOT, 'dist', 'web', 'index.html')).href;

function available() {
  if (process.platform !== 'darwin') return 'needs macOS with WKWebView';
  if (!existsSync(join(ROOT, 'dist', 'web', 'index.html'))) return 'run `npm run build` first';
  try {
    execFileSync('swift', ['--version'], { stdio: 'ignore' });
  } catch {
    return 'swift is not installed';
  }
  return false;
}

const skip = available();

/**
 * Load a URL and evaluate `expression` until it returns something non-empty.
 * Expressions that click first use a `window.__done` guard so the polling does
 * not fire the click repeatedly.
 */
function evaluate(url, expression, settleMs = 400) {
  return execFileSync('swift', [DRIVER, url, `js:${expression}`, ROOT, String(settleMs)], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

const HANDOFF = {
  url: 'https://www.nytimes.com/2026/03/14/science/quantum-error-correction.html',
  title: 'The Quiet Revolution in Quantum Error Correction',
  selection: 'The surface code needs thousands of physical qubits to protect a single logical one.',
  fragment: 'The%20surface%20code%20needs%20thousands,single%20logical%20one.',
  scroll: 0.63,
  from: 'Work laptop',
  media: { seconds: 754, duration: 1800 },
  sentAt: Date.now() - 120000,
};

test('the receiver page', { skip, concurrency: false }, async (t) => {
  const link = await buildLink(HANDOFF, RECEIVER);

  await t.test('renders what is being handed over', () => {
    const text = evaluate(link, "document.querySelector('.handoff')?.textContent ?? ''");
    assert.match(text, /nytimes\.com/);
    assert.match(text, /The Quiet Revolution in Quantum Error Correction/);
    assert.match(text, /Jumps to your selection/);
    assert.match(text, /Playing at 12:34 of 30:00/);
    assert.match(text, /from Work laptop/);
    assert.match(text, /The surface code needs thousands/);
  });

  await t.test('the open button carries the text fragment', () => {
    const href = evaluate(link, "document.querySelector('.open').href");
    assert.equal(
      href,
      'https://www.nytimes.com/2026/03/14/science/quantum-error-correction.html' +
        '#:~:text=The%20surface%20code%20needs%20thousands,single%20logical%20one.',
    );
  });

  await t.test('turning off "restore my place" gives the plain page', () => {
    const href = evaluate(
      link,
      `(window.__done || (window.__done = 1, (() => {
         const box = document.querySelector('.restore');
         box.checked = false;
         box.dispatchEvent(new Event('change'));
       })()), document.querySelector('.open').href)`,
    );
    // No `#:~:text=`, and no timestamp either: this is not a site PassIt knows
    // how to seek, so the chip is informational only.
    assert.equal(
      href,
      'https://www.nytimes.com/2026/03/14/science/quantum-error-correction.html',
    );
  });

  await t.test('a site PassIt can seek keeps its timestamp in the link', async () => {
    const video = await buildLink(
      {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'A lecture',
        media: { seconds: 754, duration: 1800 },
      },
      RECEIVER,
    );
    const href = evaluate(video, "document.querySelector('.open').href");
    assert.equal(href, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754');
  });

  await t.test('"pass it on" builds a scannable code for the next device', () => {
    // The QR is built asynchronously, so the probe has to return nothing until
    // it exists — otherwise the driver stops polling on the first evaluation.
    const result = evaluate(
      link,
      `(window.__done || (window.__done = 1, document.querySelector('.pass-on').click()),
        document.querySelector('.qr-holder svg')
          ? JSON.stringify({
              paths: document.querySelectorAll('.qr-holder svg path').length,
              meta: document.querySelector('.qr-meta').textContent,
            })
          : '')`,
      700,
    );
    const { paths, meta } = JSON.parse(result);
    assert.equal(paths, 1, 'expected one path of QR modules');
    assert.match(meta, /^version \d+ · [LMQH] · \d+ characters$/);
  });

  // ── Safety ──────────────────────────────────────────────────────────────
  await t.test('refuses to hand the user a non-web scheme', async () => {
    // A QR code can say anything. Rendered as an anchor on this origin, a
    // `javascript:` URL would execute here rather than navigate anywhere.
    for (const url of ['javascript:alert(document.domain)', 'data:text/html,<h1>hi']) {
      const hostile = await buildLink({ ...HANDOFF, url }, RECEIVER);
      const reason = evaluate(hostile, "document.querySelector('.error .reason')?.textContent ?? ''");
      assert.match(reason, /only opens web pages|not a web address/, `allowed ${url}`);
    }
  });

  await t.test('a mangled payload explains itself instead of breaking', () => {
    const reason = evaluate(
      `${RECEIVER}#PZZZZZZZ`,
      "document.querySelector('.error .reason')?.textContent ?? ''",
    );
    assert.match(reason, /payload version/);
  });

  // ── Home ────────────────────────────────────────────────────────────────
  await t.test('the home page offers a bookmarklet pointing back at itself', () => {
    const result = evaluate(
      RECEIVER,
      `JSON.stringify({
         href: document.querySelector('.bookmarklet').href.slice(0, 11),
         size: document.querySelector('.bookmarklet').href.length,
         pointsHere: decodeURIComponent(document.querySelector('.bookmarklet').href)
           .includes(location.href.split('#')[0]),
       })`,
    );
    const { href, size, pointsHere } = JSON.parse(result);
    assert.equal(href, 'javascript:');
    assert.ok(size > 10000, `bookmarklet looks truncated at ${size} characters`);
    assert.ok(pointsHere, 'the bookmarklet does not point back at this page');
  });
});
