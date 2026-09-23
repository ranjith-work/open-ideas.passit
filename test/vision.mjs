// Round-trips generated QR symbols through Apple's Vision decoder.
//
// Self-consistency tests cannot catch a wrong ECC table or a bad mask; an
// independent decoder can. Skipped automatically where `swift` is unavailable.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeQR } from '../shared/qr.js';
import { qrToPng } from '../tools/png.mjs';

const DECODER = fileURLToPath(new URL('../tools/decode-qr.swift', import.meta.url));

export function swiftAvailable() {
  try {
    execFileSync('swift', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Encode each text, render it, decode with Vision, and return the payloads.
 * @param {Array<{text:string, options?:object}>} cases
 */
export function decodeWithVision(cases) {
  const dir = mkdtempSync(join(tmpdir(), 'passit-qr-'));
  try {
    const paths = cases.map((testCase, index) => {
      const qr = encodeQR(testCase.text, testCase.options);
      const path = join(dir, `qr-${index}.png`);
      writeFileSync(path, qrToPng(qr, { scale: 8, border: 4 }));
      return path;
    });
    const stdout = execFileSync('swift', [DECODER, ...paths], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [status, ...rest] = line.split('\t');
        return { ok: status === 'OK', payload: rest.join('\t') };
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
