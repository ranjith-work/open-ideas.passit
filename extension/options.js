import { loadSettings, saveSettings } from './settings.js';
import { normalizeReceiver } from './shared/codec.js';

const form = document.getElementById('form');
const receiver = document.getElementById('receiver');
const deviceName = document.getElementById('device-name');
const saved = document.getElementById('saved');

const settings = await loadSettings();
receiver.value = settings.receiver;
deviceName.value = settings.deviceName;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveSettings({
    receiver: normalizeReceiver(receiver.value),
    deviceName: deviceName.value.trim(),
  });
  saved.hidden = false;
  setTimeout(() => {
    saved.hidden = true;
  }, 1600);
});
