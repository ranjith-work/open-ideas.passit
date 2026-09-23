// Builds dist/web (a static site) and dist/extension (loadable unpacked).
//
// There is no bundler here on purpose: the browser targets all speak ES
// modules, so "building" means copying `shared/` into each output and
// producing the two artefacts that genuinely cannot be modules — the script
// the extension injects into a page, and the bookmarklet.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { rgbaPng } from './tools/png.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const SHARED = join(ROOT, 'shared');

const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

/* ── Module → classic script ───────────────────────────────────────────────
 * Concatenating a few dependency-ordered modules and dropping their import /
 * export syntax is enough for the two non-module artefacts. It only works
 * because `shared/` has no circular or renamed imports; the check below fails
 * the build loudly if that ever stops being true.
 */
const IMPORT_RE = /^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+(?=(?:async\s+function|function|const|let|class))/gm;
const EXPORT_LIST_RE = /^export\s*\{[^}]*\};?[ \t]*$/gm;

function toClassic(files, tail = '') {
  const parts = files.map((file) => {
    const source = read('shared', file);
    const stripped = source
      .replace(IMPORT_RE, '')
      .replace(EXPORT_LIST_RE, '')
      .replace(EXPORT_DECL_RE, '');
    if (/^\s*export[\s{]/m.test(stripped)) {
      throw new Error(`Unhandled export syntax left in shared/${file}`);
    }
    return `/* ── shared/${file} ── */\n${stripped.trim()}`;
  });
  const bundle = `(() => {\n'use strict';\n${parts.join('\n\n')}\n${tail}\n})();\n`;

  // Compiling without running catches the failure mode this approach is prone
  // to: two modules declaring the same top-level name once they share a scope.
  try {
    new Function(bundle);
  } catch (error) {
    throw new Error(`Generated bundle (${files.join(' + ')}) does not compile: ${error.message}`);
  }
  return bundle;
}

/** Strip comment-only lines and indentation so the bookmarklet URL stays short. */
function squeeze(source) {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .join('\n');
}

/* ── Icons ─────────────────────────────────────────────────────────────────
 * Drawn rather than shipped as binaries: three QR finder squares and the two
 * dots of a handoff, supersampled down to each size the manifest asks for.
 */
const ACCENT = [0x7c, 0x8c, 0xff];

function drawIcon(size) {
  const ss = 4; // Supersampling factor.
  const n = size * ss;
  const buf = new Uint8Array(n * n * 4);
  const unit = n / 128;
  const radius = 26 * unit;

  const inRoundRect = (x, y, left, top, w, h, r) => {
    const dx = Math.max(left - x, 0, x - (left + w));
    const dy = Math.max(top - y, 0, y - (top + h));
    if (dx === 0 && dy === 0) return true;
    if (r <= 0) return false;
    const cx = Math.min(Math.max(x, left + r), left + w - r);
    const cy = Math.min(Math.max(y, top + r), top + h - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  const finders = [
    [16, 16],
    [76, 16],
    [16, 76],
  ].map(([x, y]) => [x * unit, y * unit, 36 * unit]);
  const dots = [
    [78, 78, 14],
    [98, 98, 14],
  ].map(([x, y, s]) => [x * unit, y * unit, s * unit]);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      if (!inRoundRect(x, y, 0, 0, n, n, radius)) continue;

      let white = false;
      for (const [fx, fy, fs] of finders) {
        const outer = x >= fx && x < fx + fs && y >= fy && y < fy + fs;
        const hole =
          x >= fx + fs / 3 && x < fx + (fs * 2) / 3 && y >= fy + fs / 3 && y < fy + (fs * 2) / 3;
        if (outer && !hole) white = true;
      }
      for (const [dx, dy, ds] of dots) {
        if (x >= dx && x < dx + ds && y >= dy && y < dy + ds) white = true;
      }

      const [r, g, b] = white ? [255, 255, 255] : ACCENT;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }

  // Box-downsample the supersampled buffer.
  const out = new Uint8Array(size * size * 4);
  const area = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const i = ((y * ss + sy) * n + x * ss + sx) * 4;
          const alpha = buf[i + 3] / 255;
          r += buf[i] * alpha;
          g += buf[i + 1] * alpha;
          b += buf[i + 2] * alpha;
          a += buf[i + 3];
        }
      }
      const o = (y * size + x) * 4;
      const cover = a / 255 || 1;
      out[o] = Math.round(r / cover);
      out[o + 1] = Math.round(g / cover);
      out[o + 2] = Math.round(b / cover);
      out[o + 3] = Math.round(a / area);
    }
  }
  return rgbaPng(out, size, size);
}

/* ── Build ─────────────────────────────────────────────────────────────── */

function kb(path) {
  return `${(statSync(path).size / 1024).toFixed(1)} kB`;
}

rmSync(DIST, { recursive: true, force: true });

// --- Web -------------------------------------------------------------------
const WEB = join(DIST, 'web');
mkdirSync(WEB, { recursive: true });
cpSync(join(ROOT, 'web'), WEB, { recursive: true });
cpSync(SHARED, join(WEB, 'shared'), { recursive: true });

// The bookmarklet ships as a module the page imports, with the receiver left
// as a placeholder: the page fills in its own origin at runtime, so a copy
// hosted anywhere hands out a bookmarklet that points back at itself.
const bookmarkletSource = squeeze(
  toClassic(['target.js', 'capture.js', 'codec.js', 'qr.js', 'bookmarklet-ui.js']),
);
const bookmarkletUrl = `javascript:${encodeURIComponent(bookmarkletSource)}`;
writeFileSync(
  join(WEB, 'bookmarklet.js'),
  '// Generated by build.js — the receiver placeholder is filled in at runtime.\n' +
    `const TEMPLATE = ${JSON.stringify(bookmarkletUrl)};\n\n` +
    'const base = location.href.split("#")[0];\n' +
    'export const BOOKMARKLET = TEMPLATE.replace(\n' +
    '  "__PASSIT_RECEIVER__",\n' +
    '  encodeURIComponent(base),\n' +
    ');\n',
);

// --- Extension -------------------------------------------------------------
const EXT = join(DIST, 'extension');
mkdirSync(join(EXT, 'icons'), { recursive: true });
cpSync(join(ROOT, 'extension'), EXT, { recursive: true });
cpSync(SHARED, join(EXT, 'shared'), { recursive: true });

// `chrome.scripting.executeScript({files})` returns the script's completion
// value, so the injected file ends with a bare call rather than a return.
writeFileSync(
  join(EXT, 'injected.js'),
  '// Generated by build.js from shared/target.js + shared/capture.js.\n' +
    toClassic(['target.js', 'capture.js'], 'return capturePageState();'),
);

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(EXT, 'icons', `icon-${size}.png`), drawIcon(size));
}

writeFileSync(
  join(EXT, 'INSTALL.txt'),
  [
    'PassIt — install the extension',
    '',
    '1. Unzip this archive. You should see a folder with manifest.json inside.',
    '2. Open chrome://extensions (also works in Edge, Brave, Arc).',
    '3. Turn on Developer mode (top right).',
    '4. Click “Load unpacked” and choose the unzipped folder.',
    '5. Open the extension’s Options and set the Receiver URL to the PassIt',
    '   site you downloaded this from (for example https://….netlify.app/).',
    '6. Press ⌥⇧P (Alt+Shift+P) on any tab to hand it off.',
    '',
    'Chrome will not install a random .zip as an extension for security reasons.',
    '“Load unpacked” is the supported way until PassIt is on the Chrome Web Store.',
    '',
  ].join('\n'),
);

// Ship the extension from the same origin as the receiver page so visitors
// never have to clone the repo. `zip` is on macOS and on Netlify’s build image.
const EXT_ZIP = join(WEB, 'passit-extension.zip');
try {
  execFileSync('zip', ['-r', '-q', EXT_ZIP, '.'], { cwd: EXT, stdio: 'pipe' });
} catch (error) {
  throw new Error(
    `Could not zip dist/extension (is the zip CLI installed?): ${error.message}`,
  );
}

console.log('PassIt built');
console.log(`  dist/web             receiver page`);
console.log(`  dist/extension       load unpacked in chrome://extensions`);
console.log(`  passit-extension.zip ${kb(EXT_ZIP)}  (download from the site)`);
console.log(`  bookmarklet          ${(bookmarkletUrl.length / 1024).toFixed(1)} kB URL`);
console.log(`  injected.js          ${kb(join(EXT, 'injected.js'))}`);
