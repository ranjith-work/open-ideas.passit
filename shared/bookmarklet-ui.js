// The bookmarklet's entry point: capture, encode, and show the code over the
// page it was clicked on.
//
// Everything lives in a shadow root because this runs on someone else's page —
// their CSS must not reach in, and ours must not leak out.

import { capturePageState } from './capture.js';
import { buildLink } from './codec.js';
import { encodeQR, qrToSvg } from './qr.js';

const HOST_ID = 'passit-overlay-host';
const RECEIVER = '__PASSIT_RECEIVER__';

const STYLE = `
  :host { all: initial; }
  .backdrop {
    position: fixed; inset: 0; z-index: 2147483647;
    display: grid; place-items: center;
    background: rgba(8, 9, 14, 0.62);
    -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
    font: 400 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    animation: fade .18s ease both;
  }
  @keyframes fade { from { opacity: 0 } }
  .card {
    width: min(340px, 86vw);
    display: flex; flex-direction: column; gap: 14px;
    padding: 20px; border-radius: 20px;
    background: #fff; color: #11131a;
    box-shadow: 0 30px 70px -20px rgba(0,0,0,.55);
  }
  .qr { display: block; width: 100%; height: auto; color: #000; }
  .title {
    margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -.01em;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .host { margin: 0; font-size: 12px; color: #6b7280; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 0; padding: 0; list-style: none; }
  .chip {
    padding: 3px 8px; border-radius: 999px; font-size: 11px;
    color: #4b5563; background: #f1f2f6;
  }
  .chip.good { color: #0f7a43; background: #dff5e8; }
  .row { display: flex; gap: 8px; }
  button {
    flex: 1; padding: 10px; border: 0; border-radius: 10px;
    font: inherit; font-size: 13px; font-weight: 560; cursor: pointer;
    background: #eceef4; color: #11131a;
  }
  button:hover { background: #e2e5ee; }
  button.primary { background: #4a5bd8; color: #fff; }
  button.primary:hover { background: #4152c8; }
  .error { margin: 0; font-size: 13px; color: #b42318; }
`;

function chipList(state) {
  const chips = [];
  if (state.fragment) {
    chips.push([state.selection ? 'Jumps to selection' : 'Jumps to your place', 'good']);
  } else if (state.scroll != null) {
    chips.push([`${Math.round(state.scroll * 100)}% down`, '']);
  }
  if (state.media?.seconds) {
    const m = Math.floor(state.media.seconds / 60);
    const s = String(state.media.seconds % 60).padStart(2, '0');
    chips.push([`At ${m}:${s}`, '']);
  }
  return chips;
}

function close() {
  document.getElementById(HOST_ID)?.remove();
}

async function run() {
  close(); // Clicking the bookmarklet twice should toggle, not stack.

  const state = capturePageState();
  delete state.viewportFragment;

  const host = document.createElement('div');
  host.id = HOST_ID;
  // Open rather than closed: a closed root is not a security boundary against
  // the page (which can script anything here anyway), and an open one keeps
  // the overlay inspectable when something goes wrong on a real site.
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });

  const card = document.createElement('div');
  card.className = 'card';
  backdrop.append(card);
  root.append(style, backdrop);
  document.documentElement.append(host);

  const onKey = (event) => {
    if (event.key === 'Escape') {
      close();
      window.removeEventListener('keydown', onKey, true);
    }
  };
  window.addEventListener('keydown', onKey, true);

  let link;
  try {
    link = await buildLink(state, RECEIVER);
    const qr = encodeQR(link, { ecc: 'M' });
    const holder = document.createElement('div');
    holder.innerHTML = qrToSvg(qr, { border: 2, dark: 'currentColor' });
    holder.firstElementChild.classList.add('qr');
    card.append(holder.firstElementChild);
  } catch (error) {
    const message = document.createElement('p');
    message.className = 'error';
    message.textContent = `PassIt could not build a code: ${error.message}`;
    card.append(message);
  }

  const title = document.createElement('p');
  title.className = 'title';
  title.textContent = state.title || location.hostname;
  card.append(title);

  const hostLine = document.createElement('p');
  hostLine.className = 'host';
  hostLine.textContent = location.hostname.replace(/^www\./, '');
  card.append(hostLine);

  const chips = chipList(state);
  if (chips.length) {
    const list = document.createElement('ul');
    list.className = 'chips';
    for (const [text, kind] of chips) {
      const item = document.createElement('li');
      item.className = kind ? `chip ${kind}` : 'chip';
      item.textContent = text;
      list.append(item);
    }
    card.append(list);
  }

  const row = document.createElement('div');
  row.className = 'row';
  const copy = document.createElement('button');
  copy.className = 'primary';
  copy.textContent = 'Copy link';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy blocked here';
    }
  });
  const done = document.createElement('button');
  done.textContent = 'Close';
  done.addEventListener('click', close);
  row.append(copy, done);
  card.append(row);
}

run();
