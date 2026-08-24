const FX_MODES = Object.freeze(['normal', 'wide', 'surround', 'room', 'hall']);

const DEFAULT_FX = Object.freeze({
  mode: 'wide',
  effectAmount: 50,
  bassLevel: 0,
  trebleLevel: 0,
  bypass: false
});

const DEFAULT_FX_PREFERENCES = Object.freeze({
  startupEffectLevel: 50,
  rememberModeLevels: true,
  startupMode: 'last',
  lastUsedMode: 'wide',
  effectLevels: {},
  bassLevel: 0,
  trebleLevel: 0
});

const DEFAULT_RECORDING_SETTINGS = Object.freeze({
  useTabTitle: true,
  useTimestamp: false,
  autoTrim: true,
  autoStop10Min: true
});

const ui = {
  powerButton: document.getElementById('powerButton'),
  modeButtons: [...document.querySelectorAll('.modeButton')],
  effectSlider: document.getElementById('effectSlider'),
  effectReadout: document.getElementById('effectReadout'),
  bassSlider: document.getElementById('bassSlider'),
  bassReadout: document.getElementById('bassReadout'),
  trebleSlider: document.getElementById('trebleSlider'),
  trebleReadout: document.getElementById('trebleReadout'),
  toneCell: document.querySelector('.toneCell'),
  bypassButton: document.getElementById('bypassButton'),
  resetButton: document.getElementById('resetButton'),
  recordButton: document.getElementById('recordButton'),
  recordLabel: document.getElementById('recordLabel'),
  displayMode: document.getElementById('displayMode'),
  displayValue: document.getElementById('displayValue'),
  tabName: document.getElementById('tabName'),
  recordTime: document.getElementById('recordTime'),
  statusText: document.getElementById('statusText'),
  settingsButton: document.getElementById('settingsButton')
};

let engineState = {
  active: false,
  recordingStatus: 'idle',
  savedSeconds: 0,
  tabTitle: '',
  ...DEFAULT_FX
};
let busy = false;
let pollTimer = null;
let sliderTimer = null;
let transientError = '';

init().catch(showError);

async function init() {
  const preferences = await loadFxPreferences();
  const previewFx = resolveStartupFx(preferences);
  engineState.mode = previewFx.mode;
  engineState.effectAmount = previewFx.effectAmount;
  engineState.bypass = previewFx.bypass;
  engineState.bassLevel = previewFx.bassLevel;
  engineState.trebleLevel = previewFx.trebleLevel;

  bindUi();
  await refreshState();
  render();
  pollTimer = setInterval(() => void refreshState(), 400);
}

function bindUi() {
  ui.powerButton.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    render();
    try {
      if (engineState.active) await stopFx();
      else await startFx();
      await refreshState();
      transientError = '';
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      render();
    }
  });

  for (const button of ui.modeButtons) {
    button.addEventListener('click', async () => {
      const mode = normalizeMode(button.dataset.mode);
      const preferences = await loadFxPreferences();
      const amount = getModeAmount(mode, preferences);

      engineState.mode = mode;
      engineState.effectAmount = amount;
      // Selecting a named mode is an explicit request to leave BYPASS.
      engineState.bypass = false;

      await chrome.storage.local.set({ lastUsedMode: mode });
      render();

      if (engineState.active) {
        await sendOffscreen({
          type: 'set-fx-settings',
          mode,
          effectAmount: amount,
          bassLevel: engineState.bassLevel,
          trebleLevel: engineState.trebleLevel,
          bypass: false
        });
      }
    });
  }

  ui.effectSlider.addEventListener('input', () => {
    const amount = normalizeAmount(ui.effectSlider.value);
    engineState.effectAmount = amount;
    ui.effectReadout.value = String(amount);
    renderDisplay();

    if (sliderTimer !== null) clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => {
      sliderTimer = null;
      void persistCurrentEffectAmount(amount);
      if (engineState.active) {
        void sendOffscreen({ type: 'set-effect-amount', effectAmount: amount });
      }
    }, 35);
  });

  const bindToneSlider = (slider, readout, key, messageType) => {
    slider.addEventListener('input', () => {
      const level = normalizeToneLevel(slider.value);
      engineState[key] = level;
      readout.value = String(level);
      void chrome.storage.local.set({ [key]: level });
      if (engineState.active) {
        void sendOffscreen({ type: messageType, level });
      }
    });
  };

  bindToneSlider(ui.bassSlider, ui.bassReadout, 'bassLevel', 'set-bass-level');
  bindToneSlider(ui.trebleSlider, ui.trebleReadout, 'trebleLevel', 'set-treble-level');

  ui.bypassButton.addEventListener('click', async () => {
    const nextBypass = !engineState.bypass;
    engineState.bypass = nextBypass;

    // When BYPASS was the startup/last-used state, the underlying mode is WIDE,
    // so disabling BYPASS naturally returns to WIDE. Temporary A/B bypass from
    // another mode keeps that mode underneath and returns to it instead.
    await chrome.storage.local.set({
      lastUsedMode: nextBypass ? 'bypass' : engineState.mode
    });

    render();
    if (engineState.active) {
      await sendOffscreen({ type: 'set-bypass', bypass: nextBypass });
    }
  });

  ui.resetButton.addEventListener('click', async () => {
    engineState.mode = DEFAULT_FX.mode;
    engineState.effectAmount = DEFAULT_FX.effectAmount;
    engineState.bypass = DEFAULT_FX.bypass;
    engineState.bassLevel = DEFAULT_FX.bassLevel;
    engineState.trebleLevel = DEFAULT_FX.trebleLevel;

    const preferences = await loadFxPreferences();
    const updates = {
      lastUsedMode: DEFAULT_FX.mode,
      bassLevel: DEFAULT_FX.bassLevel,
      trebleLevel: DEFAULT_FX.trebleLevel
    };
    if (preferences.rememberModeLevels) {
      updates.effectLevels = {
        ...preferences.effectLevels,
        [DEFAULT_FX.mode]: DEFAULT_FX.effectAmount
      };
    }
    await chrome.storage.local.set(updates);

    render();
    if (engineState.active) {
      await sendOffscreen({
        type: 'set-fx-settings',
        ...DEFAULT_FX
      });
    }
  });

  ui.recordButton.addEventListener('click', async () => {
    if (!engineState.active || busy) return;
    busy = true;
    render();
    try {
      if (engineState.recordingStatus === 'recording') {
        await sendOffscreen({ type: 'stop-recording', reason: 'manual' });
      } else if (engineState.recordingStatus === 'idle') {
        const settings = await chrome.storage.local.get(DEFAULT_RECORDING_SETTINGS);
        await sendOffscreen({
          type: 'start-recording',
          settings: normalizeRecordingSettings(settings)
        });
      }
      await refreshState();
      transientError = '';
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      render();
    }
  });

  ui.settingsButton.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  window.addEventListener('unload', () => {
    if (pollTimer !== null) clearInterval(pollTimer);
    if (sliderTimer !== null) clearTimeout(sliderTimer);
  });
}

async function startFx() {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = activeTabs[0];
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('No usable active tab / 使用可能なタブがありません');
  }

  // Resolve startup state at the instant POWER is pressed so changes made in
  // Settings are honored without reopening the popup.
  const preferences = await loadFxPreferences();
  const startupFx = resolveStartupFx(preferences);
  engineState.mode = startupFx.mode;
  engineState.effectAmount = startupFx.effectAmount;
  engineState.bypass = startupFx.bypass;
  engineState.bassLevel = startupFx.bassLevel;
  engineState.trebleLevel = startupFx.trebleLevel;

  await chrome.storage.local.set({
    lastUsedMode: startupFx.bypass ? 'bypass' : startupFx.mode
  });
  render();

  const ensure = await chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'ensure-offscreen'
  });
  if (!ensure?.ok) throw new Error(ensure?.error || 'Could not start audio engine.');

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id
  });

  const response = await sendOffscreen({
    type: 'start-fx',
    data: {
      streamId,
      tabId: tab.id,
      tabTitle: chooseTabTitle(tab.title),
      fx: startupFx
    }
  });
  if (!response?.ok) throw new Error(response?.error || 'Could not start FX.');
}

async function stopFx() {
  const response = await sendOffscreen({ type: 'stop-fx', reason: 'manual' });
  if (!response?.ok) throw new Error(response?.error || 'Could not stop FX.');
}

async function refreshState() {
  try {
    const response = await chrome.runtime.sendMessage({
      target: 'service-worker',
      type: 'get-engine-state'
    });

    if (response?.ok && response.state) {
      const state = response.state;
      const wasActive = engineState.active;
      engineState.active = state.active === true;
      engineState.recordingStatus = state.recordingStatus || 'idle';
      engineState.savedSeconds = Number(state.savedSeconds || 0);
      engineState.tabTitle = state.tabTitle || '';

      // Only the running offscreen engine is authoritative for FX values.
      // When POWER is off, keep the popup's resolved startup preview instead of
      // letting a fallback state overwrite it.
      if (state.active || wasActive) {
        engineState.mode = normalizeMode(state.mode ?? engineState.mode);
        engineState.effectAmount = normalizeAmount(state.effectAmount ?? engineState.effectAmount);
        engineState.bypass = state.bypass === true;
        engineState.bassLevel = normalizeToneLevel(state.bassLevel ?? engineState.bassLevel);
        engineState.trebleLevel = normalizeToneLevel(state.trebleLevel ?? engineState.trebleLevel);
      }
    }
    render();
  } catch (error) {
    console.debug('State refresh skipped:', error);
  }
}

async function sendOffscreen(payload) {
  return chrome.runtime.sendMessage({
    target: 'offscreen',
    ...payload
  });
}

async function loadFxPreferences() {
  const raw = await chrome.storage.local.get(DEFAULT_FX_PREFERENCES);
  const effectLevels = isPlainObject(raw.effectLevels) ? raw.effectLevels : {};
  const normalizedLevels = {};
  for (const mode of FX_MODES) {
    if (Number.isFinite(Number(effectLevels[mode]))) {
      normalizedLevels[mode] = normalizeAmount(effectLevels[mode]);
    }
  }

  return {
    startupEffectLevel: normalizeAmount(raw.startupEffectLevel),
    rememberModeLevels: raw.rememberModeLevels !== false,
    startupMode: normalizeStartupMode(raw.startupMode),
    lastUsedMode: normalizePublicMode(raw.lastUsedMode),
    effectLevels: normalizedLevels,
    bassLevel: normalizeToneLevel(raw.bassLevel),
    trebleLevel: normalizeToneLevel(raw.trebleLevel)
  };
}

function resolveStartupFx(preferences) {
  const requested = preferences.startupMode === 'last'
    ? preferences.lastUsedMode
    : preferences.startupMode;

  if (requested === 'bypass') {
    // BYPASS has no intrinsic FX mode. WIDE is the deliberate fallback so the
    // first BYPASS-off action has a predictable result.
    return {
      mode: 'wide',
      effectAmount: getModeAmount('wide', preferences),
      bassLevel: preferences.bassLevel,
      trebleLevel: preferences.trebleLevel,
      bypass: true
    };
  }

  const mode = normalizeMode(requested);
  return {
    mode,
    effectAmount: getModeAmount(mode, preferences),
    bassLevel: preferences.bassLevel,
    trebleLevel: preferences.trebleLevel,
    bypass: false
  };
}

function getModeAmount(mode, preferences) {
  const normalizedMode = normalizeMode(mode);
  if (preferences.rememberModeLevels && Number.isFinite(Number(preferences.effectLevels[normalizedMode]))) {
    return normalizeAmount(preferences.effectLevels[normalizedMode]);
  }
  return normalizeAmount(preferences.startupEffectLevel);
}

async function persistCurrentEffectAmount(amount) {
  const preferences = await loadFxPreferences();
  if (!preferences.rememberModeLevels) return;

  await chrome.storage.local.set({
    effectLevels: {
      ...preferences.effectLevels,
      [engineState.mode]: normalizeAmount(amount)
    }
  });
}

function render() {
  ui.powerButton.setAttribute('aria-pressed', String(engineState.active));

  for (const button of ui.modeButtons) {
    const active = button.dataset.mode === engineState.mode && !engineState.bypass;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = busy;
  }

  ui.effectSlider.value = String(engineState.effectAmount);
  ui.effectReadout.value = String(engineState.effectAmount);
  const effectRelevant = engineState.mode !== 'normal';
  ui.effectSlider.disabled = busy || !effectRelevant;
  ui.effectSlider.closest('.effectPanel')?.classList.toggle('disabled', !effectRelevant);

  ui.bassSlider.value = String(engineState.bassLevel);
  ui.bassReadout.value = String(engineState.bassLevel);
  ui.trebleSlider.value = String(engineState.trebleLevel);
  ui.trebleReadout.value = String(engineState.trebleLevel);
  ui.bassSlider.disabled = busy;
  ui.trebleSlider.disabled = busy;

  const eqConfigured = engineState.bassLevel > 0 || engineState.trebleLevel > 0;
  ui.toneCell.classList.toggle('active', eqConfigured);

  ui.bypassButton.classList.toggle('active', engineState.bypass);
  ui.bypassButton.setAttribute('aria-pressed', String(engineState.bypass));
  ui.bypassButton.disabled = busy;
  ui.resetButton.disabled = busy;

  const recording = engineState.recordingStatus === 'recording';
  const processing = engineState.recordingStatus === 'processing';
  ui.recordButton.disabled = !engineState.active || processing || busy;
  ui.recordButton.classList.toggle('recording', recording);
  ui.recordLabel.textContent = recording ? 'STOP' : processing ? 'SAVE' : 'REC';

  if (transientError) {
    ui.statusText.textContent = transientError;
  } else if (processing) {
    ui.statusText.textContent = 'Saving WAV; FX continues. / WAV保存中。FXは継続します。';
  } else if (recording) {
    ui.statusText.textContent = engineState.bypass
      ? 'Recording clean tab audio. / 原音を録音中。'
      : 'Recording post-FX audio. / エフェクト後の音を録音中。';
  } else if (engineState.active && engineState.bypass) {
    ui.statusText.textContent = 'BYPASS active. REC records clean audio. / BYPASS中。RECで原音を録音できます。';
  } else if (engineState.active) {
    ui.statusText.textContent = 'FX active. REC records this sound. / FX作動中。この音をRECできます。';
  } else {
    ui.statusText.textContent = 'Open a music tab, then press POWER. / 音楽タブでPOWERを押してください。';
  }

  renderDisplay();
}

function renderDisplay() {
  if (!engineState.active) {
    ui.displayMode.textContent = 'OFF';
    ui.displayValue.textContent = '--';
    ui.tabName.textContent = 'No active FX / FX停止中';
  } else {
    const eqActive = !engineState.bypass && (engineState.bassLevel > 0 || engineState.trebleLevel > 0);
    ui.displayMode.textContent = engineState.bypass
      ? 'BYPASS'
      : `${engineState.mode.toUpperCase()}${eqActive ? ' +EQ' : ''}`;
    ui.displayValue.textContent = engineState.bypass
      ? 'DRY'
      : engineState.mode === 'normal'
        ? `B${engineState.bassLevel} T${engineState.trebleLevel}`
        : `FX ${engineState.effectAmount}`;
    ui.tabName.textContent = engineState.tabTitle || 'Current tab / 現在のタブ';
  }
  ui.recordTime.textContent = formatTime(engineState.savedSeconds || 0);
}

function showError(error) {
  console.error('Sound FX & Recorder popup:', error);
  transientError = `ERROR / エラー: ${error?.message || String(error)}`;
  render();
}

function chooseTabTitle(title) {
  const value = String(title || '').trim();
  if (!value) return 'tab_audio';
  const unusable = new Set([
    'new tab', '新しいタブ', 'about:blank', 'loading...', '読み込み中...'
  ]);
  return unusable.has(value.toLowerCase()) ? 'tab_audio' : value;
}

function normalizeMode(value) {
  return FX_MODES.includes(value) ? value : DEFAULT_FX.mode;
}

function normalizePublicMode(value) {
  return [...FX_MODES, 'bypass'].includes(value) ? value : 'wide';
}

function normalizeStartupMode(value) {
  return ['last', ...FX_MODES, 'bypass'].includes(value) ? value : 'last';
}

function normalizeAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_FX.effectAmount;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeToneLevel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(10, Math.round(number)));
}

function normalizeRecordingSettings(settings) {
  return {
    useTabTitle: settings.useTabTitle !== false,
    useTimestamp: settings.useTimestamp === true,
    autoTrim: settings.autoTrim !== false,
    autoStop10Min: settings.autoStop10Min !== false
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatTime(secondsValue) {
  const total = Math.max(0, Math.floor(Number(secondsValue || 0)));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
