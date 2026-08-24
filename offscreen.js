const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;

const TRIM_THRESHOLD_DB = -55;
const ANALYSIS_BLOCK_MS = 20;
const MINIMUM_ACTIVE_MS = 60;
const LEADING_PADDING_MS = 250;
const TRAILING_PADDING_MS = 500;
const AUTO_STOP_SECONDS = 10 * 60;
const MIX_RAMP_SECONDS = 0.025;

// EFFECT remains additive: clean stays at unity and the selected enhancement
// is added on top. v0.1.3 deliberately pushes the four modes into obvious
// retro-gadget territory rather than subtle hi-fi processing.
const EFFECT_MAX_GAIN = Object.freeze({
  // Old WIDE 100 is now roughly EFFECT 50.
  wide: 1.20,
  // Phase/difference surround is designed to become conspicuous above 40.
  surround: 1.05,
  // Old HALL 100 is roughly the new ROOM 50 target.
  room: 0.80,
  // v0.1.4: HALL intensity reduced to half of v0.1.3 after listening test.
  hall: 0.60
});

const DEFAULT_FX = Object.freeze({
  mode: 'wide',
  effectAmount: 50,
  bassLevel: 0,
  trebleLevel: 0,
  bypass: false
});

const DEFAULT_RECORDING_SETTINGS = Object.freeze({
  useTabTitle: true,
  useTimestamp: false,
  autoTrim: true,
  autoStop10Min: true
});

let sessionActive = false;
let sessionTabId = null;
let sessionTabTitle = '';
let capturedStream = null;
let audioContext = null;
let sourceNode = null;
let mixBus = null;
let dryGain = null;
let bassFilterNode = null;
let trebleFilterNode = null;
let limiterNode = null;
let processedGain = null;
let bypassGain = null;
let recorderNode = null;
let effectGains = new Map();
let managedNodes = [];

let fxSettings = { ...DEFAULT_FX };
let recordingStatus = 'idle';
let recordingSettings = { ...DEFAULT_RECORDING_SETTINGS };
let currentFilename = 'tab_audio.wav';
let recordingStopPromise = null;

let pcmChunks = [];
let totalFrames = 0;
let sampleRate = 48000;
let analysisBlockFrames = 960;
let analysisFramesInBlock = 0;
let analysisSumSquaresLeft = 0;
let analysisSumSquaresRight = 0;
let analysisLevels = [];
let flushResolver = null;
let lastDisplayedSavedSecond = -1;
let displayedSavedSeconds = 0;
let autoStopTriggered = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  void (async () => {
    try {
      let result = { ok: true };

      switch (message.type) {
        case 'get-state':
          result = { ok: true, state: getPublicState() };
          break;
        case 'start-fx':
          await startFx(message.data || {});
          result = { ok: true, state: getPublicState() };
          break;
        case 'stop-fx':
          await stopFx(message.reason || 'manual');
          result = { ok: true, state: getPublicState() };
          break;
        case 'set-mode':
          setMode(message.mode);
          result = { ok: true, state: getPublicState() };
          break;
        case 'set-effect-amount':
          setEffectAmount(message.effectAmount);
          result = { ok: true, state: getPublicState() };
          break;
        case 'set-bass-level':
          setBassLevel(message.level);
          result = { ok: true, state: getPublicState() };
          break;
        case 'set-treble-level':
          setTrebleLevel(message.level);
          result = { ok: true, state: getPublicState() };
          break;
        case 'set-bypass':
          setBypass(message.bypass);
          result = { ok: true, state: getPublicState() };
          break;
        case 'set-fx-settings':
          setFxSettings(message);
          result = { ok: true, state: getPublicState() };
          break;
        case 'start-recording':
          await startRecording(message.settings || {});
          result = { ok: true, state: getPublicState() };
          break;
        case 'stop-recording':
          await stopRecording(message.reason || 'manual');
          result = { ok: true, state: getPublicState() };
          break;
        default:
          result = { ok: false, error: `Unknown offscreen message: ${message.type}` };
      }

      sendResponse(result);
    } catch (error) {
      const text = error?.message || String(error);
      reportError(text);
      sendResponse({ ok: false, error: text, state: getPublicState() });
    }
  })();

  return true;
});

async function startFx({ streamId, tabId, tabTitle, fx }) {
  if (sessionActive) {
    throw new Error('FX is already active. / FXはすでに作動中です。');
  }
  if (!streamId) throw new Error('No tab capture stream ID was provided.');

  fxSettings = normalizeFxSettings(fx);
  sessionTabId = typeof tabId === 'number' ? tabId : null;
  sessionTabTitle = chooseTabTitle(tabTitle);
  displayedSavedSeconds = 0;

  try {
    capturedStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    if (capturedStream.getAudioTracks().length === 0) {
      throw new Error('The selected tab did not provide an audio track.');
    }

    audioContext = new AudioContext({ latencyHint: 'interactive' });
    sampleRate = audioContext.sampleRate;
    analysisBlockFrames = Math.max(
      1,
      Math.round(sampleRate * ANALYSIS_BLOCK_MS / 1000)
    );

    await audioContext.audioWorklet.addModule(
      chrome.runtime.getURL('pcm-recorder-worklet.js')
    );

    sourceNode = trackNode(audioContext.createMediaStreamSource(capturedStream));
    buildFxGraph();

    recorderNode = trackNode(new AudioWorkletNode(audioContext, 'pcm-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [CHANNELS],
      channelCount: CHANNELS,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers'
    }));
    recorderNode.port.onmessage = handleWorkletMessage;

    processedGain.connect(recorderNode);
    bypassGain.connect(recorderNode);
    recorderNode.connect(audioContext.destination);

    if (audioContext.state === 'suspended') await audioContext.resume();

    sessionActive = true;
    recordingStatus = 'idle';
    applyMixGains(true);
    notifyStateChanged();

    const audioTrack = capturedStream.getAudioTracks()[0];
    audioTrack.addEventListener('ended', () => {
      if (sessionActive) void stopFx('track-ended');
    }, { once: true });
  } catch (error) {
    await cleanupAudio();
    sessionActive = false;
    sessionTabId = null;
    sessionTabTitle = '';
    throw error;
  }
}

function buildFxGraph() {
  mixBus = trackNode(audioContext.createGain());
  dryGain = trackNode(audioContext.createGain());
  sourceNode.connect(dryGain);
  dryGain.connect(mixBus);

  const wideOutput = createWideEffect(sourceNode);
  const surroundOutput = createSurroundEffect(sourceNode);
  const roomOutput = createConvolutionEffect(sourceNode, 'room');
  const hallOutput = createConvolutionEffect(sourceNode, 'hall');

  effectGains = new Map();
  for (const [mode, output] of [
    ['wide', wideOutput],
    ['surround', surroundOutput],
    ['room', roomOutput],
    ['hall', hallOutput]
  ]) {
    const gain = trackNode(audioContext.createGain());
    gain.gain.value = 0;
    output.connect(gain);
    gain.connect(mixBus);
    effectGains.set(mode, gain);
  }

  // Global tone boosts are independent from the spatial/reverb mode.
  // NORMAL leaves all effectGains at zero and runs clean audio through
  // these optional shelves. BYPASS skips the entire processed path.
  bassFilterNode = trackNode(audioContext.createBiquadFilter());
  bassFilterNode.type = 'lowshelf';
  bassFilterNode.frequency.value = 120;
  bassFilterNode.gain.value = 0;

  trebleFilterNode = trackNode(audioContext.createBiquadFilter());
  trebleFilterNode.type = 'highshelf';
  trebleFilterNode.frequency.value = 6000;
  trebleFilterNode.gain.value = 0;

  limiterNode = trackNode(audioContext.createDynamicsCompressor());
  limiterNode.threshold.value = -0.8;
  limiterNode.knee.value = 0.5;
  limiterNode.ratio.value = 16;
  limiterNode.attack.value = 0.002;
  limiterNode.release.value = 0.10;

  mixBus.connect(bassFilterNode);
  bassFilterNode.connect(trebleFilterNode);
  trebleFilterNode.connect(limiterNode);

  // Keep BYPASS genuinely transparent: the clean tab signal skips the
  // limiter/effect path entirely. processedGain and bypassGain are
  // crossfaded when BYPASS is toggled.
  processedGain = trackNode(audioContext.createGain());
  processedGain.gain.value = 1;
  limiterNode.connect(processedGain);

  bypassGain = trackNode(audioContext.createGain());
  bypassGain.gain.value = 0;
  sourceNode.connect(bypassGain);
}

function createWideEffect(source) {
  // Output ONLY the stereo-side delta. The clean source is already present
  // on dryGain, so adding this signal increases width without duplicating the
  // complete program signal. Ldelta = +(L-R)/2, Rdelta = -(L-R)/2.
  const splitter = trackNode(audioContext.createChannelSplitter(2));
  const merger = trackNode(audioContext.createChannelMerger(2));

  const leftToLeft = gainNode(0.5);
  const rightToLeft = gainNode(-0.5);
  const leftToRight = gainNode(-0.5);
  const rightToRight = gainNode(0.5);

  source.connect(splitter);
  splitter.connect(leftToLeft, 0);
  splitter.connect(leftToRight, 0);
  splitter.connect(rightToLeft, 1);
  splitter.connect(rightToRight, 1);

  leftToLeft.connect(merger, 0, 0);
  rightToLeft.connect(merger, 0, 0);
  leftToRight.connect(merger, 0, 1);
  rightToRight.connect(merger, 0, 1);

  return merger;
}

function createSurroundEffect(source) {
  // Deliberately old-school pseudo-surround.
  //
  // A simple 17-24 ms cross-delay sounded like a faint room reflection. Here
  // we create a *difference/phase* halo instead: each output receives a local
  // short phase-shifted tap plus a stronger polarity-inverted opposite-channel
  // tap. Several all-pass stages and asymmetric 3-12 ms delays make correlated
  // centre material partially cancel/reappear by frequency, producing the
  // characteristic "swishy / outside-the-head" analogue-surround impression.
  // The returned signal is WET ONLY; clean remains on dryGain at unity.
  const splitter = trackNode(audioContext.createChannelSplitter(2));
  const merger = trackNode(audioContext.createChannelMerger(2));
  source.connect(splitter);

  // Left wet: +phase-shifted L - differently phase-shifted/delayed R.
  connectPhaseSurroundTap(splitter, 0, merger, 0, {
    delaySeconds: 0.0032,
    gain: 0.62,
    allpassHz: [430, 1180, 2860]
  });
  connectPhaseSurroundTap(splitter, 1, merger, 0, {
    delaySeconds: 0.0076,
    gain: -0.78,
    allpassHz: [610, 1670, 3820]
  });
  connectPhaseSurroundTap(splitter, 1, merger, 0, {
    delaySeconds: 0.0127,
    gain: -0.24,
    allpassHz: [930, 2440]
  });

  // Right wet uses different time/frequency constants so the phase field is
  // intentionally asymmetric rather than merely sounding like WIDE.
  connectPhaseSurroundTap(splitter, 1, merger, 1, {
    delaySeconds: 0.0044,
    gain: 0.62,
    allpassHz: [520, 1390, 3240]
  });
  connectPhaseSurroundTap(splitter, 0, merger, 1, {
    delaySeconds: 0.0089,
    gain: -0.78,
    allpassHz: [760, 1910, 4310]
  });
  connectPhaseSurroundTap(splitter, 0, merger, 1, {
    delaySeconds: 0.0141,
    gain: -0.24,
    allpassHz: [1050, 2730]
  });

  return merger;
}

function connectPhaseSurroundTap(splitter, sourceChannel, merger, targetChannel, config) {
  const highpass = trackNode(audioContext.createBiquadFilter());
  highpass.type = 'highpass';
  highpass.frequency.value = 170;
  highpass.Q.value = 0.55;

  let tail = highpass;
  for (const frequency of config.allpassHz) {
    const allpass = trackNode(audioContext.createBiquadFilter());
    allpass.type = 'allpass';
    allpass.frequency.value = frequency;
    allpass.Q.value = 0.72;
    tail.connect(allpass);
    tail = allpass;
  }

  const delay = trackNode(audioContext.createDelay(0.04));
  delay.delayTime.value = config.delaySeconds;

  const lowpass = trackNode(audioContext.createBiquadFilter());
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 9300;
  lowpass.Q.value = 0.35;

  const tapGain = gainNode(config.gain);

  splitter.connect(highpass, sourceChannel);
  tail.connect(delay);
  delay.connect(lowpass);
  lowpass.connect(tapGain);
  tapGain.connect(merger, 0, targetChannel);
}

function createConvolutionEffect(source, kind) {
  const preDelay = trackNode(audioContext.createDelay(0.16));
  preDelay.delayTime.value = kind === 'room' ? 0.014 : 0.021;

  const highpass = trackNode(audioContext.createBiquadFilter());
  highpass.type = 'highpass';
  highpass.frequency.value = kind === 'room' ? 120 : 145;
  highpass.Q.value = 0.5;

  const convolver = trackNode(audioContext.createConvolver());
  convolver.normalize = true;
  convolver.buffer = createImpulseResponse(kind);

  const lowpass = trackNode(audioContext.createBiquadFilter());
  lowpass.type = 'lowpass';
  lowpass.frequency.value = kind === 'room' ? 9000 : 7200;
  lowpass.Q.value = 0.35;

  const output = trackNode(audioContext.createGain());
  output.gain.value = 1.0;

  source.connect(preDelay);
  preDelay.connect(highpass);
  highpass.connect(convolver);
  convolver.connect(lowpass);
  lowpass.connect(output);
  return output;
}

function createImpulseResponse(kind) {
  const duration = kind === 'room' ? 1.15 : 2.70;
  const length = Math.max(1, Math.round(sampleRate * duration));
  const buffer = audioContext.createBuffer(2, length, sampleRate);

  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  let seed = kind === 'room' ? 0x13579bdf : 0x2468ace1;

  function randomSigned() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 0x100000000) * 2 - 1;
  }

  const decayPower = kind === 'room' ? 3.15 : 2.45;
  const noiseLevel = kind === 'room' ? 0.12 : 0.075;

  for (let i = 0; i < length; i += 1) {
    const t = i / length;
    const envelope = Math.pow(1 - t, decayPower);
    left[i] = randomSigned() * envelope * noiseLevel;
    right[i] = randomSigned() * envelope * noiseLevel;
  }

  const reflections = kind === 'room'
    ? [
        [0.000, 0.64, 0.58],
        [0.013, 0.48, -0.36],
        [0.027, -0.34, 0.46],
        [0.046, 0.31, 0.24],
        [0.071, -0.23, 0.29],
        [0.104, 0.20, -0.17],
        [0.151, -0.13, 0.16],
        [0.223, 0.10, -0.12]
      ]
    : [
        [0.000, 0.50, 0.45],
        [0.037, 0.34, -0.27],
        [0.069, -0.24, 0.32],
        [0.116, 0.26, 0.20],
        [0.181, -0.19, 0.23],
        [0.274, 0.17, -0.14],
        [0.402, -0.12, 0.15],
        [0.611, 0.10, -0.11],
        [0.891, -0.08, 0.09]
      ];

  for (const [seconds, leftAmp, rightAmp] of reflections) {
    const index = Math.min(length - 1, Math.round(seconds * sampleRate));
    left[index] += leftAmp;
    right[index] += rightAmp;
  }

  return buffer;
}

function gainNode(value) {
  const node = trackNode(audioContext.createGain());
  node.gain.value = value;
  return node;
}

function trackNode(node) {
  managedNodes.push(node);
  return node;
}

function setMode(mode) {
  fxSettings.mode = normalizeMode(mode);
  if (sessionActive) applyMixGains(false);
  notifyStateChanged();
}

function setEffectAmount(value) {
  fxSettings.effectAmount = normalizeAmount(value);
  if (sessionActive) applyMixGains(false);
  notifyStateChanged();
}

function setBassLevel(value) {
  fxSettings.bassLevel = normalizeToneLevel(value);
  if (sessionActive) applyMixGains(false);
  notifyStateChanged();
}

function setTrebleLevel(value) {
  fxSettings.trebleLevel = normalizeToneLevel(value);
  if (sessionActive) applyMixGains(false);
  notifyStateChanged();
}

function setBypass(value) {
  fxSettings.bypass = value === true;
  if (sessionActive) applyMixGains(false);
  notifyStateChanged();
}

function setFxSettings(settings) {
  fxSettings = normalizeFxSettings(settings);
  if (sessionActive) applyMixGains(false);
  notifyStateChanged();
}

function applyMixGains(immediate) {
  if (!audioContext || !dryGain || !processedGain || !bypassGain) return;

  const now = audioContext.currentTime;
  const amount = fxSettings.effectAmount / 100;

  // v0.1.3 mixing rule:
  //   processed = clean at unity + additive effect component
  // The clean program is NEVER faded down when EFFECT is increased.
  setAudioParam(dryGain.gain, 1.0, now, immediate);

  for (const [mode, gain] of effectGains.entries()) {
    const maxGain = EFFECT_MAX_GAIN[mode] ?? 0;
    const target = mode === fxSettings.mode ? amount * maxGain : 0;
    setAudioParam(gain.gain, target, now, immediate);
  }

  // Tone boosts are simple gadget-style shelves. BASS 0-10 maps to
  // BASS 0-10 maps to 0..+12 dB at 120 Hz; TREBLE 0-10 maps to 0..+12 dB at 6 kHz.
  if (bassFilterNode) {
    setAudioParam(bassFilterNode.gain, fxSettings.bassLevel * 1.2, now, immediate);
  }
  if (trebleFilterNode) {
    setAudioParam(trebleFilterNode.gain, fxSettings.trebleLevel * 1.2, now, immediate);
  }

  // BYPASS remains a true A/B path and skips EQ, limiter, and effect graph.
  const processed = fxSettings.bypass ? 0 : 1;
  const clean = 1 - processed;
  setAudioParam(processedGain.gain, processed, now, immediate);
  setAudioParam(bypassGain.gain, clean, now, immediate);
}

function setAudioParam(param, value, now, immediate) {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  if (immediate) param.setValueAtTime(value, now);
  else param.linearRampToValueAtTime(value, now + MIX_RAMP_SECONDS);
}

async function startRecording(settings) {
  if (!sessionActive || !recorderNode) {
    throw new Error('Turn POWER on before recording. / 録音前にPOWERをONにしてください。');
  }
  if (recordingStatus !== 'idle') {
    throw new Error('Recorder is not ready. / 録音機が準備中です。');
  }

  recordingSettings = normalizeRecordingSettings(settings);
  currentFilename = buildFilename(sessionTabTitle, recordingSettings, new Date());
  resetRecordingBuffers();
  recordingStatus = 'recording';
  recorderNode.port.postMessage({ type: 'start-recording' });
  maybeSendDisplayedDuration(true);
  notifyStateChanged();
}

async function stopRecording(reason = 'manual') {
  if (recordingStatus === 'processing' && recordingStopPromise) {
    return recordingStopPromise;
  }
  if (recordingStatus !== 'recording') return;

  recordingStopPromise = finishRecording(reason).finally(() => {
    recordingStopPromise = null;
  });
  return recordingStopPromise;
}

async function finishRecording(reason) {
  recordingStatus = 'processing';
  notifyStateChanged();
  chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'recording-processing',
    reason
  });

  try {
    await flushWorklet();
    finalizePartialAnalysisBlock();
    const stats = await saveWav();
    displayedSavedSeconds = Math.max(0, Math.floor(Number(stats.savedSeconds || 0)));
    recordingStatus = 'idle';
    resetRecordingBuffers({ keepDisplayedSeconds: true });
    notifyStateChanged();

    chrome.runtime.sendMessage({
      target: 'service-worker',
      type: 'recording-stopped',
      stats
    });
    return stats;
  } catch (error) {
    recordingStatus = 'idle';
    resetRecordingBuffers({ keepDisplayedSeconds: true });
    notifyStateChanged();
    throw error;
  }
}

async function stopFx(reason = 'manual') {
  if (!sessionActive && !audioContext) return;

  if (recordingStatus === 'recording') {
    await stopRecording(reason === 'manual' ? 'fx-stop' : reason);
  } else if (recordingStatus === 'processing' && recordingStopPromise) {
    await recordingStopPromise;
  }

  sessionActive = false;
  await cleanupAudio();
  sessionTabId = null;
  sessionTabTitle = '';
  recordingStatus = 'idle';
  notifyStateChanged();
}

function handleWorkletMessage(event) {
  const data = event.data || {};

  if (data.type === 'pcm') {
    appendPcm(data.left, data.right, data.frames);
    return;
  }

  if (data.type === 'flushed' && flushResolver) {
    const resolve = flushResolver;
    flushResolver = null;
    resolve();
  }
}

async function flushWorklet() {
  if (!recorderNode) return;

  const flushed = new Promise((resolve) => {
    flushResolver = resolve;
  });

  recorderNode.port.postMessage({ type: 'stop-and-flush' });

  await Promise.race([
    flushed,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error('Timed out while flushing PCM audio.')),
        2000
      );
    })
  ]);
}

function appendPcm(left, right, frameCount) {
  if (!['recording', 'processing'].includes(recordingStatus)) return;
  if (!(left instanceof Float32Array) || frameCount <= 0) return;

  const rightChannel =
    right instanceof Float32Array && right.length >= frameCount
      ? right
      : left;

  let acceptedFrames = frameCount;

  if (recordingSettings.autoStop10Min) {
    const maxFrames = Math.round(sampleRate * AUTO_STOP_SECONDS);
    const remainingFrames = Math.max(0, maxFrames - totalFrames);
    acceptedFrames = Math.min(frameCount, remainingFrames);
  }

  if (acceptedFrames > 0) {
    const interleaved = new Int16Array(acceptedFrames * CHANNELS);

    for (let i = 0; i < acceptedFrames; i += 1) {
      const leftSample = clampSample(left[i] || 0);
      const rightSample = clampSample(rightChannel[i] || 0);

      interleaved[i * 2] = floatToInt16(leftSample);
      interleaved[i * 2 + 1] = floatToInt16(rightSample);

      analysisSumSquaresLeft += leftSample * leftSample;
      analysisSumSquaresRight += rightSample * rightSample;
      analysisFramesInBlock += 1;

      if (analysisFramesInBlock >= analysisBlockFrames) pushCurrentRmsBlock();
    }

    pcmChunks.push(interleaved);
    totalFrames += acceptedFrames;
  }

  maybeSendDisplayedDuration(false);

  if (
    recordingSettings.autoStop10Min &&
    !autoStopTriggered &&
    totalFrames >= Math.round(sampleRate * AUTO_STOP_SECONDS) &&
    recordingStatus === 'recording'
  ) {
    autoStopTriggered = true;
    void stopRecording('auto-stop');
  }
}

function pushCurrentRmsBlock() {
  if (analysisFramesInBlock <= 0) return;

  const leftRms = Math.sqrt(analysisSumSquaresLeft / analysisFramesInBlock);
  const rightRms = Math.sqrt(analysisSumSquaresRight / analysisFramesInBlock);
  analysisLevels.push(Math.max(leftRms, rightRms));

  analysisFramesInBlock = 0;
  analysisSumSquaresLeft = 0;
  analysisSumSquaresRight = 0;
}

function finalizePartialAnalysisBlock() {
  if (analysisFramesInBlock > 0) pushCurrentRmsBlock();
}

function maybeSendDisplayedDuration(force) {
  if (!['recording', 'processing'].includes(recordingStatus)) return;

  let savedFrames = totalFrames;

  if (recordingSettings.autoTrim) {
    const estimate = PCMUtils.computeEstimatedSavedFrames({
      levels: analysisLevels,
      blockFrames: analysisBlockFrames,
      processedFrames: totalFrames,
      sampleRate,
      thresholdDb: TRIM_THRESHOLD_DB,
      minimumActiveMs: MINIMUM_ACTIVE_MS,
      leadingPaddingMs: LEADING_PADDING_MS,
      trailingPaddingMs: TRAILING_PADDING_MS
    });
    savedFrames = estimate.savedFrames;
  }

  const savedSeconds = Math.max(0, Math.floor(savedFrames / sampleRate));
  displayedSavedSeconds = savedSeconds;
  if (!force && savedSeconds === lastDisplayedSavedSecond) return;
  lastDisplayedSavedSecond = savedSeconds;

  chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'recording-estimated-duration',
    savedSeconds,
    autoTrim: recordingSettings.autoTrim
  });
  notifyStateChanged();
}

async function saveWav() {
  if (totalFrames <= 0) {
    throw new Error('The recording contains no PCM audio.');
  }

  let trim;
  if (recordingSettings.autoTrim) {
    trim = PCMUtils.computeBoundaryTrim({
      levels: analysisLevels,
      blockFrames: analysisBlockFrames,
      totalFrames,
      sampleRate,
      thresholdDb: TRIM_THRESHOLD_DB,
      minimumActiveMs: MINIMUM_ACTIVE_MS,
      leadingPaddingMs: LEADING_PADDING_MS,
      trailingPaddingMs: TRAILING_PADDING_MS
    });
  } else {
    trim = { startFrame: 0, endFrame: totalFrames, foundAudio: true };
  }

  const savedFrames = trim.endFrame - trim.startFrame;
  if (savedFrames <= 0) throw new Error('No audio remained after trimming.');

  const bytesPerFrame = CHANNELS * (BITS_PER_SAMPLE / 8);
  const dataBytes = savedFrames * bytesPerFrame;
  const header = PCMUtils.makeWavHeader({
    sampleRate,
    channels: CHANNELS,
    bitsPerSample: BITS_PER_SAMPLE,
    dataBytes
  });

  const blobParts = [header];
  let cursorFrame = 0;

  for (const chunk of pcmChunks) {
    const chunkFrames = chunk.length / CHANNELS;
    const chunkStart = cursorFrame;
    const chunkEnd = cursorFrame + chunkFrames;

    if (chunkEnd > trim.startFrame && chunkStart < trim.endFrame) {
      const overlapStart = Math.max(trim.startFrame, chunkStart);
      const overlapEnd = Math.min(trim.endFrame, chunkEnd);
      const localStartSample = (overlapStart - chunkStart) * CHANNELS;
      const localEndSample = (overlapEnd - chunkStart) * CHANNELS;
      const selected = chunk.subarray(localStartSample, localEndSample);

      blobParts.push(
        new Uint8Array(selected.buffer, selected.byteOffset, selected.byteLength)
      );
    }

    cursorFrame = chunkEnd;
    if (cursorFrame >= trim.endFrame) break;
  }

  const blob = new Blob(blobParts, { type: 'audio/wav' });
  if (blob.size !== 44 + dataBytes) {
    throw new Error(`WAV size mismatch: expected ${44 + dataBytes}, got ${blob.size}.`);
  }

  await requestDownload(blob, currentFilename);

  return {
    capturedSeconds: totalFrames / sampleRate,
    savedSeconds: savedFrames / sampleRate,
    leadingTrimSeconds: trim.startFrame / sampleRate,
    trailingTrimSeconds: (totalFrames - trim.endFrame) / sampleRate,
    foundAudio: trim.foundAudio,
    sampleRate,
    filename: currentFilename
  };
}

async function requestDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const response = await chrome.runtime.sendMessage({
      target: 'service-worker',
      type: 'download-wav',
      url,
      filename
    });
    if (!response?.ok) throw new Error(response?.error || 'WAV download failed.');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

async function cleanupAudio() {
  for (const node of managedNodes) {
    try { node.disconnect(); } catch {}
  }
  managedNodes = [];
  effectGains = new Map();

  sourceNode = null;
  mixBus = null;
  dryGain = null;
  bassFilterNode = null;
  trebleFilterNode = null;
  limiterNode = null;
  processedGain = null;
  bypassGain = null;
  recorderNode = null;

  if (capturedStream) {
    for (const track of capturedStream.getTracks()) {
      if (track.readyState !== 'ended') track.stop();
    }
  }
  capturedStream = null;

  if (audioContext && audioContext.state !== 'closed') {
    try { await audioContext.close(); } catch {}
  }
  audioContext = null;
  flushResolver = null;
}

function getPublicState() {
  return {
    active: sessionActive,
    recordingStatus,
    mode: fxSettings.mode,
    effectAmount: fxSettings.effectAmount,
    bassLevel: fxSettings.bassLevel,
    trebleLevel: fxSettings.trebleLevel,
    bypass: fxSettings.bypass,
    savedSeconds: displayedSavedSeconds,
    tabTitle: sessionTabTitle,
    tabId: sessionTabId
  };
}

function notifyStateChanged() {
  chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'engine-state-changed',
    state: getPublicState()
  }).catch(() => {});
}

function resetRecordingBuffers({ keepDisplayedSeconds = false } = {}) {
  pcmChunks = [];
  totalFrames = 0;
  analysisFramesInBlock = 0;
  analysisSumSquaresLeft = 0;
  analysisSumSquaresRight = 0;
  analysisLevels = [];
  flushResolver = null;
  lastDisplayedSavedSecond = -1;
  autoStopTriggered = false;
  if (!keepDisplayedSeconds) displayedSavedSeconds = 0;
}

function buildFilename(tabTitle, settings, date) {
  const base = settings.useTabTitle ? chooseTabTitle(tabTitle) : 'tab_audio';
  const safeBase = sanitizeFilenamePart(base) || 'tab_audio';
  const suffix = settings.useTimestamp ? `_${formatTimestamp(date)}` : '';
  return `${safeBase}${suffix}.wav`;
}

function sanitizeFilenamePart(value) {
  let safe = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();

  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (reserved.test(safe)) safe = `_${safe}`;
  if (safe.length > 160) safe = safe.slice(0, 160).replace(/[. ]+$/g, '');
  return safe;
}

function chooseTabTitle(title) {
  const value = String(title || '').trim();
  if (!value) return 'tab_audio';
  const unusable = new Set([
    'new tab', '新しいタブ', 'about:blank', 'loading...', '読み込み中...'
  ]);
  return unusable.has(value.toLowerCase()) ? 'tab_audio' : value;
}

function formatTimestamp(date) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate())
  ].join('-') + '_' + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds())
  ].join('-');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function normalizeFxSettings(settings) {
  return {
    mode: normalizeMode(settings?.mode),
    effectAmount: normalizeAmount(settings?.effectAmount),
    bassLevel: normalizeToneLevel(settings?.bassLevel),
    trebleLevel: normalizeToneLevel(settings?.trebleLevel),
    bypass: settings?.bypass === true
  };
}

function normalizeMode(value) {
  return ['normal', 'wide', 'surround', 'room', 'hall'].includes(value)
    ? value
    : DEFAULT_FX.mode;
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
    useTabTitle: settings?.useTabTitle !== false,
    useTimestamp: settings?.useTimestamp === true,
    autoTrim: settings?.autoTrim !== false,
    autoStop10Min: settings?.autoStop10Min !== false
  };
}

function clampSample(value) {
  return Math.max(-1, Math.min(1, value));
}

function floatToInt16(value) {
  return value < 0
    ? Math.round(value * 32768)
    : Math.round(value * 32767);
}

function reportError(message) {
  console.error('Sound FX & Recorder:', message);
  chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'engine-error',
    error: message
  }).catch(() => {});
}
