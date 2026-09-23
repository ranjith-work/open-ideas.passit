export const DEFAULT_RECEIVER = 'http://localhost:8787/';

const DEFAULTS = {
  // Where the PassIt receiver page is hosted. It is a static page and never
  // sees the payload, but it has to be somewhere a phone can load.
  receiver: DEFAULT_RECEIVER,
  // Shown on the receiving device as "from …". Purely cosmetic.
  deviceName: '',
};

export async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}
