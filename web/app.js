import { decodePayload, buildLink } from './shared/codec.js';
import {
  buildTargetUrl,
  formatScroll,
  formatDuration,
  supportsTextFragments,
} from './shared/target.js';
import { encodeQR, qrToSvg } from './shared/qr.js';
import { BOOKMARKLET } from './bookmarklet.js';

const view = document.getElementById('view');

/* ── Safety ────────────────────────────────────────────────────────────────
 * A handoff arrives from a QR code, which is to say from anywhere. The link is
 * rendered as an anchor on this origin, so a `javascript:` URL would execute
 * here. Only ever hand the user an http(s) destination, and never navigate
 * without a tap.
 */
const SAFE_SCHEMES = new Set(['http:', 'https:']);

function safeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('The handoff contains something that is not a web address.');
  }
  if (!SAFE_SCHEMES.has(parsed.protocol)) {
    throw new Error(`PassIt only opens web pages, and this one points at “${parsed.protocol}”.`);
  }
  return parsed;
}

/* ── Small helpers ─────────────────────────────────────────────────────── */

const clone = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);

function show(node) {
  view.replaceChildren(node);
  return node;
}

function relativeTime(timestamp) {
  if (!timestamp) return null;
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

function prettyUrl(parsed) {
  const path = decodeURIComponent(parsed.pathname + parsed.search).replace(/\/$/, '');
  return path && path !== '/' ? path : '';
}

function addChip(list, label, kind = '') {
  if (!label) return;
  const item = document.createElement('li');
  item.className = `chip${kind ? ` chip-${kind}` : ''}`;
  item.textContent = label;
  list.append(item);
}

function renderQr(holder, text, meta) {
  const qr = encodeQR(text, { ecc: 'M' });
  holder.innerHTML = qrToSvg(qr, { border: 2, dark: 'currentColor' });
  if (meta) {
    meta.textContent = `version ${qr.version} · ${qr.ecc} · ${text.length} characters`;
  }
  return qr;
}

async function copy(text, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Press ⌘C';
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    setTimeout(() => area.remove(), 8000);
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1800);
}

/* ── Handoff view ──────────────────────────────────────────────────────── */

function renderHandoff(state) {
  const parsed = safeUrl(state.url);
  const node = clone('tpl-handoff');

  node.querySelector('.host').textContent = parsed.hostname.replace(/^www\./, '');
  node.querySelector('.site-letter').textContent = parsed.hostname
    .replace(/^www\./, '')
    .charAt(0)
    .toUpperCase();

  const favicon = node.querySelector('.favicon');
  favicon.addEventListener('load', () => {
    favicon.hidden = false;
    node.querySelector('.site-letter').hidden = true;
  });
  favicon.src = `${parsed.origin}/favicon.ico`;

  node.querySelector('.title').textContent = state.title || parsed.hostname;
  node.querySelector('.url').textContent = prettyUrl(parsed) || parsed.origin;

  const chips = node.querySelector('.chips');
  const hasFragment = Boolean(state.fragment);
  const fragmentsWork = supportsTextFragments();

  if (hasFragment && fragmentsWork) {
    addChip(chips, state.selection ? 'Jumps to your selection' : 'Jumps to your place', 'good');
  } else if (state.scroll != null) {
    addChip(chips, `Was ${formatScroll(state.scroll)}`, hasFragment ? '' : 'muted');
  }
  if (hasFragment && !fragmentsWork) {
    addChip(chips, 'This browser may not scroll automatically', 'warn');
  }
  if (state.media?.seconds) {
    const at = formatDuration(state.media.seconds);
    const total = state.media.duration ? ` of ${formatDuration(state.media.duration)}` : '';
    addChip(chips, `Playing at ${at}${total}`);
  }
  if (state.from) addChip(chips, `from ${state.from}`);
  addChip(chips, relativeTime(state.sentAt));

  if (state.selection) {
    const quote = node.querySelector('.selection');
    quote.textContent = state.selection;
    quote.hidden = false;
  }
  if (state.note) {
    const note = node.querySelector('.note');
    note.textContent = state.note;
    note.hidden = false;
  }

  const open = node.querySelector('.open');
  const restore = node.querySelector('.restore');
  const syncHref = () => {
    open.href = buildTargetUrl(state, { position: restore.checked });
  };
  restore.addEventListener('change', syncHref);
  syncHref();

  if (!hasFragment && state.scroll == null && !state.media) {
    node.querySelector('.switch').hidden = true;
  }

  const panel = node.querySelector('.qr-panel');
  const passOn = node.querySelector('.pass-on');
  passOn.addEventListener('click', async () => {
    if (!panel.hidden) {
      panel.hidden = true;
      passOn.textContent = 'Pass it on…';
      return;
    }
    const link = await buildLink(state, location.href.split('#')[0]);
    renderQr(node.querySelector('.qr-holder'), link, node.querySelector('.qr-meta'));
    panel.hidden = false;
    passOn.textContent = 'Hide code';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  node.querySelector('.copy').addEventListener('click', (event) => {
    copy(buildTargetUrl(state, { position: restore.checked }), event.currentTarget);
  });

  show(node);
}

/* ── Home ──────────────────────────────────────────────────────────────── */

function renderHome() {
  const node = clone('tpl-home');

  const bookmarklet = node.querySelector('.bookmarklet');
  bookmarklet.href = BOOKMARKLET;
  bookmarklet.addEventListener('click', (event) => {
    event.preventDefault();
    bookmarklet.textContent = 'Drag me to the bookmarks bar ↑';
  });

  node.querySelector('.scan').addEventListener('click', () => {
    location.hash = 'scan';
  });
  node.querySelector('.paste').addEventListener('click', (event) => {
    renderPasteForm(event.currentTarget.closest('.actions'));
  });

  show(node);
}

function renderPasteForm(anchor) {
  if (anchor.parentElement.querySelector('.paste-form')) return;
  const form = document.createElement('form');
  form.className = 'paste-form';
  form.innerHTML =
    '<input type="url" name="link" placeholder="Paste a passit link" required spellcheck="false" />' +
    '<button class="button primary" type="submit">Go</button>';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = form.elements.link.value.trim();
    const hash = value.split('#').slice(1).join('#');
    if (!hash) {
      form.elements.link.setCustomValidity('That link has no handoff in it.');
      form.reportValidity();
      return;
    }
    location.hash = hash;
  });
  anchor.after(form);
  form.elements.link.focus();
}

/* ── Scanning (desktop pickup) ─────────────────────────────────────────── */

async function renderScan() {
  const node = show(clone('tpl-scan'));
  const video = node.querySelector('video');
  const status = node.querySelector('.scan-status');
  node.querySelector('.cancel').addEventListener('click', () => {
    location.hash = '';
  });

  if (!('BarcodeDetector' in window)) {
    status.textContent =
      'This browser cannot read QR codes. Use your phone’s camera app, or paste the link instead.';
    renderPasteForm(node.querySelector('.actions'));
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
  } catch {
    status.textContent = 'No camera access. Paste the link instead.';
    renderPasteForm(node.querySelector('.actions'));
    return;
  }

  const stop = () => stream.getTracks().forEach((track) => track.stop());
  window.addEventListener('hashchange', stop, { once: true });

  video.srcObject = stream;
  await video.play();
  status.textContent = 'Looking for a code…';

  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  const tick = async () => {
    if (!stream.active) return;
    try {
      const [found] = await detector.detect(video);
      if (found?.rawValue) {
        const hash = found.rawValue.split('#').slice(1).join('#');
        if (hash) {
          stop();
          location.hash = hash;
          return;
        }
        status.textContent = 'That code is not a PassIt handoff.';
      }
    } catch {
      /* Transient decode failures are normal between frames. */
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ── Router ────────────────────────────────────────────────────────────── */

function renderError(message) {
  const node = clone('tpl-error');
  node.querySelector('.reason').textContent = message;
  show(node);
}

async function route() {
  const hash = location.hash.slice(1);
  if (!hash) return renderHome();
  if (hash === 'scan') return renderScan();

  try {
    renderHandoff(await decodePayload(hash));
  } catch (error) {
    renderError(error.message || String(error));
  }
}

window.addEventListener('hashchange', route);
route();
