// The two generated artefacts, run the way a browser runs them.
//
// `injected.js` and the bookmarklet are the only paths where capture, the
// codec and the QR encoder share a single scope with their module syntax
// stripped away, so they are the likeliest things to break silently when
// `shared/` changes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER = join(ROOT, 'tools', 'run-page.swift');
const FIXTURE = pathToFileURL(join(ROOT, 'test', 'fixtures', 'bookmarklet.html')).href;

function available() {
  if (process.platform !== 'darwin') return 'needs macOS with WKWebView';
  if (!existsSync(join(ROOT, 'dist', 'web', 'bookmarklet.js'))) return 'run `npm run build` first';
  try {
    execFileSync('swift', ['--version'], { stdio: 'ignore' });
  } catch {
    return 'swift is not installed';
  }
  return false;
}

test('the generated artefacts', { skip: available(), concurrency: false }, async (t) => {
  const report = JSON.parse(
    execFileSync('swift', [DRIVER, FIXTURE, '#report', ROOT, '500'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );

  await t.test("the extension's injected script returns page state", () => {
    assert.equal(report.threw, undefined, `${report.threw}\n${report.stack}`);
    const state = report.injected;
    assert.ok(state, 'executeScript would have received nothing');
    assert.match(state.url, /bookmarklet\.html$/);
    assert.equal(state.title, 'Fixture: a page someone clicks the bookmarklet on');
    assert.match(
      decodeURIComponent(state.fragment),
      /Galvanised steel wire rope|Notes on the mechanical/,
      `anchored somewhere unexpected: ${decodeURIComponent(state.fragment || '')}`,
    );
  });

  await t.test('the bookmarklet runs without throwing once its modules share a scope', () => {
    assert.equal(report.threw, undefined, `${report.threw}\n${report.stack}`);
    assert.equal(report.error, null, 'the overlay reported a failure');
    assert.ok(report.sourceLength > 10000, `source looks truncated: ${report.sourceLength}`);
  });

  await t.test('puts an overlay on the page describing the handoff', () => {
    assert.equal(report.title, 'Fixture: a page someone clicks the bookmarklet on');
    assert.deepEqual(report.chips, ['Jumps to your place']);
    assert.deepEqual(report.buttons, ['Copy link', 'Close']);
  });

  await t.test('renders a real QR symbol', () => {
    assert.equal(report.qrPaths, 1);
    // Border 2 on each side, so the symbol itself is a valid QR size:
    // 21 + 4*(version - 1) modules.
    const [, , width] = report.qrViewBox.split(' ').map(Number);
    const modules = width - 4;
    assert.equal((modules - 21) % 4, 0, `${modules} is not a valid QR size`);
    assert.ok(modules >= 21 && modules <= 177, `${modules} modules is out of range`);
  });
});
