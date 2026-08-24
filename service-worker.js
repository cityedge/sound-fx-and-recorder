const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

let creatingOffscreenDocument = null;

chrome.runtime.onInstalled.addListener(async () => {
  await updateActionForState({ active: false, recordingStatus: 'idle' });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'service-worker') return;

  if (message.type === 'ensure-offscreen') {
    void (async () => {
      try {
        await ensureOffscreenDocument();
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === 'get-engine-state') {
    void (async () => {
      try {
        const context = await getOffscreenContext();
        if (!context) {
          const storedFx = await chrome.storage.local.get({
            mode: 'wide',
            effectAmount: 50,
            bassLevel: 0,
            trebleLevel: 0,
            bypass: false
          });
          sendResponse({
            ok: true,
            state: defaultEngineState(storedFx)
          });
          return;
        }
        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'get-state'
        });
        sendResponse(response || { ok: true, state: defaultEngineState() });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === 'download-wav') {
    void (async () => {
      try {
        const downloadId = await chrome.downloads.download({
          url: message.url,
          filename: message.filename,
          conflictAction: 'uniquify',
          saveAs: false
        });
        sendResponse({ ok: true, downloadId });
      } catch (error) {
        console.error('Sound FX & Recorder download error:', error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === 'engine-state-changed') {
    void updateActionForState(message.state || defaultEngineState());
    return;
  }

  if (message.type === 'recording-estimated-duration') {
    const seconds = Math.max(0, Math.floor(Number(message.savedSeconds || 0)));
    void chrome.action.setBadgeText({ text: formatBadge(seconds) });
    void chrome.action.setBadgeBackgroundColor({ color: '#C62828' });
    void chrome.action.setTitle({
      title:
        `${message.autoTrim ? 'Estimated WAV / 推定WAV長' : 'Recording / 録音中'} ` +
        `${formatLong(seconds)}\nSound FX & Recorder`
    });
    return;
  }

  if (message.type === 'recording-processing') {
    void chrome.action.setBadgeText({ text: '...' });
    void chrome.action.setBadgeBackgroundColor({ color: '#616161' });
    void chrome.action.setTitle({ title: 'Saving WAV / WAV保存処理中\nSound FX & Recorder remains active.' });
    return;
  }

  if (message.type === 'recording-stopped') {
    const stats = message.stats || {};
    void chrome.action.setBadgeText({ text: 'FX' });
    void chrome.action.setBadgeBackgroundColor({ color: '#4D6770' });
    void chrome.action.setTitle({
      title:
        `Sound FX & Recorder: ON\n` +
        `Last WAV / 前回: ${formatLong(Math.round(Number(stats.savedSeconds || 0)))}`
    });
    return;
  }

  if (message.type === 'engine-error') {
    console.error('Sound FX & Recorder:', message.error);
    void chrome.action.setBadgeText({ text: 'ERR' });
    void chrome.action.setBadgeBackgroundColor({ color: '#B71C1C' });
    void chrome.action.setTitle({
      title: `Sound FX & Recorder error / エラー: ${message.error || 'Unknown error'}`
    });
  }
});

async function ensureOffscreenDocument() {
  const existing = await getOffscreenContext();
  if (existing) return existing;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Capture the selected tab, apply real-time audio effects, monitor the result, and optionally record post-FX WAV audio.'
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }

  await creatingOffscreenDocument;
  const created = await getOffscreenContext();
  if (!created) throw new Error('Failed to create the offscreen audio engine.');
  return created;
}

async function getOffscreenContext() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  return contexts.find((context) => context.documentUrl?.includes(OFFSCREEN_DOCUMENT_PATH)) || null;
}

async function updateActionForState(state) {
  if (!state?.active) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Sound FX & Recorder / 音響FX＆録音' });
    return;
  }

  if (state.recordingStatus === 'recording') return;
  if (state.recordingStatus === 'processing') {
    await chrome.action.setBadgeText({ text: '...' });
    await chrome.action.setBadgeBackgroundColor({ color: '#616161' });
    return;
  }

  await chrome.action.setBadgeText({ text: 'FX' });
  await chrome.action.setBadgeBackgroundColor({ color: '#4D6770' });
  await chrome.action.setTitle({
    title: `Sound FX & Recorder: ON · ${state.bypass ? 'BYPASS' : String(state.mode || 'WIDE').toUpperCase()}`
  });
}

function defaultEngineState(fx = {}) {
  const mode = ['normal', 'wide', 'surround', 'room', 'hall'].includes(fx.mode)
    ? fx.mode
    : 'wide';
  const rawAmount = Number(fx.effectAmount);
  const effectAmount = Number.isFinite(rawAmount)
    ? Math.max(0, Math.min(100, Math.round(rawAmount)))
    : 50;

  return {
    active: false,
    recordingStatus: 'idle',
    mode,
    effectAmount,
    bassLevel: normalizeToneLevel(fx.bassLevel),
    trebleLevel: normalizeToneLevel(fx.trebleLevel),
    bypass: fx.bypass === true,
    savedSeconds: 0,
    tabTitle: ''
  };
}

function normalizeToneLevel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(10, Math.round(number)));
}

function formatBadge(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatLong(totalSeconds) {
  const safe = Math.max(0, Number(totalSeconds || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
