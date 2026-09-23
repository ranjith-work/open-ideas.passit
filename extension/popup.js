import { buildLink } from './shared/codec.js';
import { applyCaptureOptions } from './shared/capture.js';
import { formatScroll, formatDuration } from './shared/target.js';
import { encodeQR, qrToCanvas } from './shared/qr.js';
import { loadSettings } from './settings.js';

const el = {
  root: document.getElementById('root'),
  canvas: document.getElementById('qr'),
  placeholder: document.getElementById('placeholder'),
  title: document.getElementById('title'),
  host: document.getElementById('host'),
  chips: document.getElementById('chips'),
  controls: document.getElementById('controls'),
  position: document.getElementById('opt-position'),
  selection: document.getElementById('opt-selection'),
  selectionLabel: document.getElementById('opt-selection-label'),
  note: document.getElementById('note'),
  warning: document.getElementById('warning'),
  copy: document.getElementById('copy'),
  settings: document.getElementById('settings'),
};

let captured = null;
let settings = null;
let currentLink = '';

function chip(text, kind = '') {
  if (!text) return;
  const item = document.createElement('li');
  item.className = kind ? `chip chip-${kind}` : 'chip';
  item.textContent = text;
  el.chips.append(item);
}

function fail(message) {
  el.root.classList.remove('loading');
  el.placeholder.textContent = message;
  el.placeholder.hidden = false;
  el.canvas.hidden = true;
}

/**
 * Pages the browser protects — its own settings, the extension gallery, the
 * PDF viewer — cannot be scripted. The URL and title are still worth passing.
 */
function stateFromTabOnly(tab) {
  return { url: tab.url, title: tab.title || '', sentAt: Date.now() };
}

async function capture(tab) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['injected.js'],
    });
    if (injection?.result?.url) return { state: injection.result, limited: false };
  } catch {
    /* Falls through to the URL-only handoff below. */
  }
  return { state: stateFromTabOnly(tab), limited: true };
}

function describe(state) {
  el.chips.replaceChildren();
  if (state.fragment) {
    chip(state.selection ? 'Jumps to selection' : 'Jumps to your place', 'good');
  } else if (state.scroll != null) {
    chip(`Was ${formatScroll(state.scroll)}`);
  }
  if (state.media?.seconds) chip(`At ${formatDuration(state.media.seconds)}`);
  if (state.selection) chip(`${state.selection.length} chars selected`);
}

async function render() {
  const state = applyCaptureOptions(captured, {
    position: el.position.checked,
    selection: el.selection.checked,
  });
  const note = el.note.value.trim();
  if (note) state.note = note;
  if (settings.deviceName) state.from = settings.deviceName;

  describe(state);

  try {
    currentLink = await buildLink(state, settings.receiver);
    const qr = encodeQR(currentLink, { ecc: 'M' });
    qrToCanvas(qr, el.canvas, { border: 2, dark: '#000', light: '#fff' });
    el.canvas.hidden = false;
    el.placeholder.hidden = true;
  } catch (error) {
    // The only realistic cause is a state too large for any QR version, which
    // means a very long URL — trim what we can and say so.
    fail(`Too much to fit in a code: ${error.message}`);
  }
}

/** The default receiver is localhost, which no phone can load. Say so. */
function warnIfUnreachable() {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(settings.receiver)) return;
  el.warning.innerHTML =
    'Your receiver is <b>localhost</b> — a phone cannot reach it. ' +
    'Run <code>npm start</code> and put the printed LAN address in settings (⚙).';
  el.warning.hidden = false;
}

async function main() {
  settings = await loadSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return fail('No page to pass.');

  const { state, limited } = await capture(tab);
  captured = state;

  el.root.classList.remove('loading');
  el.title.textContent = state.title || tab.title || '';
  try {
    el.host.textContent = new URL(state.url).hostname.replace(/^www\./, '');
  } catch {
    el.host.textContent = state.url;
  }

  if (limited) {
    el.warning.textContent =
      'This page cannot be read by extensions, so only the address is being passed.';
    el.warning.hidden = false;
  } else {
    el.controls.hidden = false;
    if (!state.selection) {
      el.selection.checked = false;
      el.selection.disabled = true;
      el.selectionLabel.textContent = 'Selected text (none)';
    }
    warnIfUnreachable();
  }

  el.position.addEventListener('change', render);
  el.selection.addEventListener('change', render);

  let noteTimer;
  el.note.addEventListener('input', () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(render, 220);
  });

  el.copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(currentLink);
    el.copy.textContent = 'Copied';
    setTimeout(() => {
      el.copy.textContent = 'Copy link';
    }, 1600);
  });

  el.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());

  await render();
}

main();
