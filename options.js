const DEFAULT_SETTINGS = Object.freeze({
  startupEffectLevel: 50,
  rememberModeLevels: true,
  startupMode: 'last',
  useTabTitle: true,
  useTimestamp: false,
  autoTrim: true,
  autoStop10Min: true
});

const controls = {
  startupEffectLevel: document.getElementById('startupEffectLevel'),
  startupEffectReadout: document.getElementById('startupEffectReadout'),
  rememberModeLevels: document.getElementById('rememberModeLevels'),
  startupMode: document.getElementById('startupMode'),
  useTabTitle: document.getElementById('useTabTitle'),
  useTimestamp: document.getElementById('useTimestamp'),
  autoTrim: document.getElementById('autoTrim'),
  autoStop10Min: document.getElementById('autoStop10Min')
};

const filenamePreview = document.getElementById('filenamePreview');
const saveStatus = document.getElementById('saveStatus');
let saveStatusTimer = null;
let startupLevelTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);

  const startupLevel = normalizeAmount(settings.startupEffectLevel);
  controls.startupEffectLevel.value = String(startupLevel);
  controls.startupEffectReadout.value = String(startupLevel);
  controls.rememberModeLevels.checked = settings.rememberModeLevels !== false;
  controls.startupMode.value = normalizeStartupMode(settings.startupMode);

  controls.useTabTitle.checked = settings.useTabTitle !== false;
  controls.useTimestamp.checked = settings.useTimestamp === true;
  controls.autoTrim.checked = settings.autoTrim !== false;
  controls.autoStop10Min.checked = settings.autoStop10Min !== false;

  updateFilenamePreview();
  bindFxSettings();
  bindRecordingSettings();
});

function bindFxSettings() {
  controls.startupEffectLevel.addEventListener('input', () => {
    const amount = normalizeAmount(controls.startupEffectLevel.value);
    controls.startupEffectReadout.value = String(amount);

    if (startupLevelTimer !== null) clearTimeout(startupLevelTimer);
    startupLevelTimer = setTimeout(async () => {
      startupLevelTimer = null;
      await chrome.storage.local.set({ startupEffectLevel: amount });
      showSaved();
    }, 80);
  });

  controls.rememberModeLevels.addEventListener('change', async () => {
    await chrome.storage.local.set({ rememberModeLevels: controls.rememberModeLevels.checked });
    showSaved();
  });

  controls.startupMode.addEventListener('change', async () => {
    const startupMode = normalizeStartupMode(controls.startupMode.value);
    controls.startupMode.value = startupMode;
    await chrome.storage.local.set({ startupMode });
    showSaved();
  });
}

function bindRecordingSettings() {
  for (const key of ['useTabTitle', 'useTimestamp', 'autoTrim', 'autoStop10Min']) {
    const control = controls[key];
    control.addEventListener('change', async () => {
      await chrome.storage.local.set({ [key]: control.checked });
      if (key === 'useTabTitle' || key === 'useTimestamp') updateFilenamePreview();
      showSaved();
    });
  }
}

function updateFilenamePreview() {
  const base = controls.useTabTitle.checked ? '[Tab title here]' : 'tab_audio';
  const stamp = controls.useTimestamp.checked ? '_YYYY-MM-DD_HH-MM-SS' : '';
  filenamePreview.textContent = `${base}${stamp}.wav`;
}

function normalizeAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_SETTINGS.startupEffectLevel;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeStartupMode(value) {
  return ['last', 'wide', 'surround', 'room', 'hall', 'bypass'].includes(value)
    ? value
    : DEFAULT_SETTINGS.startupMode;
}

function showSaved() {
  saveStatus.textContent = 'Saved / 保存しました';
  if (saveStatusTimer !== null) clearTimeout(saveStatusTimer);
  saveStatusTimer = setTimeout(() => {
    saveStatus.textContent = '';
    saveStatusTimer = null;
  }, 1600);
}
