/* global chrome */
'use strict';

// MediaRecorder runs a single, continuous WebM/Opus muxing session. Its
// successive dataavailable Blobs are appended IN ORDER to one OPFS file.
// Unlike the PCM WAV engine, no hour-long audio/Blob array is held in RAM.
const OPUS_MIME_TYPE = 'audio/webm;codecs=opus';
const OPUS_CHUNK_INTERVAL_MS = 2000;
const OPUS_TEMP_DIRECTORY = 'sfxr-recording-temp';
const OPUS_TEMP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const opusAnalysisModules = new WeakMap();

class OpusRecording {
  constructor({ context, outputNode, recordingFormat, filename, autoTrim = false, trimSettings, onProgress, onUnexpectedStop }) {
    if (!['opus-stereo', 'opus-mono'].includes(recordingFormat)) {
      throw new Error('Invalid Opus recording format.');
    }
    this.context = context;
    this.outputNode = outputNode;
    this.recordingFormat = recordingFormat;
    this.filename = filename;
    this.autoTrim = autoTrim;
    this.trimSettings = trimSettings;
    this.onProgress = onProgress;
    this.onUnexpectedStop = onUnexpectedStop;
    this.targetBitrate = recordingFormat === 'opus-mono' ? 64000 : 128000;
    this.nodes = [];
    this.destination = null;
    this.tap = null;
    this.recorder = null;
    this.fileHandle = null;
    this.directory = null;
    this.fileName = null;
    this.writable = null;
    this.writeChain = Promise.resolve();
    this.writeError = null;
    this.stopEvent = null;
    this.progressTimer = null;
    this.startTime = 0;
    this.stopTime = 0;
    this.bytesWritten = 0;
    this.stopRequested = false;
    this.analyser = null;
    this.boundaries = null;
    this.analysisError = null;
    this.snapshotPending = false;
    this.analysisStop = null;
  }

  async start() {
    if (!globalThis.MediaRecorder || !MediaRecorder.isTypeSupported(OPUS_MIME_TYPE)) {
      throw new Error('WebM/Opus is not supported by this version of Chrome.');
    }
    if (!navigator.storage?.getDirectory) {
      throw new Error('Chrome OPFS storage is unavailable. Opus recording requires OPFS.');
    }

    try {
      if (this.autoTrim) {
        if (!opusAnalysisModules.has(this.context)) {
          opusAnalysisModules.set(this.context, this.context.audioWorklet.addModule(chrome.runtime.getURL('silence-detector-worklet.js')));
        }
        await opusAnalysisModules.get(this.context);
      }
      this.destination = this._makeRecordingStream();
      const root = await navigator.storage.getDirectory();
      this.directory = await root.getDirectoryHandle(OPUS_TEMP_DIRECTORY, { create: true });
      this.fileName = `opus-${Date.now()}-${crypto.randomUUID().slice(0, 12)}.webm`;
      this.fileHandle = await this.directory.getFileHandle(this.fileName, { create: true });
      this.writable = await this.fileHandle.createWritable();
      if (this.analyser) {
        let timeout;
        try {
          await Promise.race([this.analysisReady, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Timed out starting live silence analysis.')), 2000);
          })]);
          if (this.analysisError) throw this.analysisError;
        } finally { clearTimeout(timeout); }
      }

      this.recorder = new MediaRecorder(this.destination.stream, {
        mimeType: OPUS_MIME_TYPE,
        audioBitsPerSecond: this.targetBitrate
      });
      this.stopEvent = new Promise((resolve) => {
        this.recorder.addEventListener('stop', () => {
          this.stopTime = performance.now();
          this._stopAnalysis();
          resolve();
          if (!this.stopRequested) this.onUnexpectedStop?.();
        }, { once: true });
      });

      this.recorder.addEventListener('dataavailable', (event) => {
        const blob = event.data;
        if (!blob || blob.size === 0) return;
        this.writeChain = this.writeChain.then(async () => {
          await this.writable.write(blob);
          this.bytesWritten += blob.size;
        });
        // Install a rejection handler immediately, while keeping the original
        // rejected promise available to stop() for the actual error.
        this.writeChain.catch((error) => this._fail(error));
      });
      this.recorder.addEventListener('error', (event) => {
        this._fail(event.error || new Error('MediaRecorder encoding error.'));
      });

      const startFrame = Math.round(this.context.currentTime * this.context.sampleRate);
      this.recorder.start(OPUS_CHUNK_INTERVAL_MS);
      this.analyser?.port.postMessage({ type: 'start', startFrame, settings: this.trimSettings });
      this.startTime = performance.now();
      this.progressTimer = setInterval(() => {
        if (this.analyser && !this.analysisError) {
          // At most one snapshot request can be queued, even if the UI is busy.
          if (!this.snapshotPending) {
            this.snapshotPending = true;
            this.analyser.port.postMessage({ type: 'snapshot' });
          }
        } else this.onProgress?.(this.elapsedSeconds());
      }, 500);
      this.onProgress?.(0);
    } catch (error) {
      await this.discard();
      throw error;
    }
  }

  _makeRecordingStream() {
    const ctx = this.context;
    this.tap = ctx.createGain();
    this.nodes.push(this.tap);
    this.outputNode.connect(this.tap);

    const destination = ctx.createMediaStreamDestination();
    this.nodes.push(destination);
    let analysisSource = this.tap;

    if (this.recordingFormat === 'opus-stereo') {
      this.tap.connect(destination);
    } else {
      // Explicit downmix on the recording branch only. Speakers keep their
      // original 2-channel monitor signal; L and R are combined at 0.5 each.
      const splitter = ctx.createChannelSplitter(2);
      const leftGain = ctx.createGain();
      const rightGain = ctx.createGain();
      const mono = ctx.createChannelMerger(1);
      leftGain.gain.value = 0.5;
      rightGain.gain.value = 0.5;
      this.nodes.push(splitter, leftGain, rightGain, mono);
      this.tap.connect(splitter);
      splitter.connect(leftGain, 0);
      splitter.connect(rightGain, 1);
      leftGain.connect(mono, 0, 0);
      rightGain.connect(mono, 0, 0);
      destination.channelCount = 1;
      destination.channelCountMode = 'explicit';
      mono.connect(destination);
      analysisSource = mono;
    }
    if (this.autoTrim) {
      const channels = this.recordingFormat === 'opus-mono' ? 1 : 2;
      this.analyser = new AudioWorkletNode(ctx, 'silence-detector', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'discrete'
      });
      this.nodes.push(this.analyser);
      analysisSource.connect(this.analyser);
      // Silent output makes the analysis branch run; no extra audible path is added.
      this.analyser.connect(ctx.destination);
      this.analysisReady = new Promise(resolve => { this.resolveAnalysisReady = resolve; });
      this.analyser.port.onmessage = ({ data }) => {
        if (data.type === 'ready') { this.resolveAnalysisReady(); return; }
        this.snapshotPending = false;
        if (data.error) this.analysisError = new Error(data.error);
        this.boundaries = data;
        if (data.type === 'snapshot') this.onProgress?.(this.analysisError ? this.elapsedSeconds() : data.savedSeconds);
        if (data.type === 'stopped') this.resolveAnalysisStop?.();
      };
      this.analyser.onprocessorerror = () => {
        this.analysisError = new Error('Live silence analysis failed.');
        this.resolveAnalysisReady();
        this.resolveAnalysisStop?.();
      };
    }
    return destination;
  }

  _stopAnalysis() {
    if (!this.analyser || this.analysisStop) return this.analysisStop;
    this.analysisStop = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.analysisError = new Error('Timed out finishing live silence analysis.');
        this.resolveAnalysisStop();
      }, 2000);
      this.resolveAnalysisStop = () => { clearTimeout(timeout); resolve(); };
      this.analyser.port.postMessage({ type: 'stop' });
      if (this.analysisError) this.resolveAnalysisStop();
    });
    return this.analysisStop;
  }

  elapsedSeconds() {
    if (!this.startTime) return 0;
    return Math.max(0, ((this.stopTime || performance.now()) - this.startTime) / 1000);
  }

  _fail(error) {
    if (this.writeError) return;
    this.writeError = error instanceof Error ? error : new Error(String(error));
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }

  async stop() {
    this.stopRequested = true;
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    try {
      if (!this.recorder) throw new Error('Opus recorder was not initialized.');
      if (this.recorder.state !== 'inactive') this.recorder.stop();
      this._stopAnalysis();
      await Promise.race([
        this.stopEvent,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out stopping Opus recording.')), 10000))
      ]);
      await this.writeChain;
      await this.analysisStop;
      if (this.writeError) throw this.writeError;
      await this.writable.close();
      this.writable = null;

      // File is backed by browser-local OPFS, not a heap-sized PCM buffer.
      let file = await this.fileHandle.getFile();
      if (file.size <= 0) throw new Error('Opus recording produced no data.');
      // Release only the recording tap before the potentially longer disk pass.
      // The offscreen monitor/DSP graph continues running throughout trimming.
      this._releaseGraph();
      let trimStats = {};
      if (this.autoTrim) {
        try {
          if (this.analysisError) throw this.analysisError;
          const trimmed = await this._trimFile(file);
          trimStats = trimmed.stats;
          if (!trimmed.unchanged) {
            const originalName = this.fileName;
            this.fileName = trimmed.name;
            file = trimmed.file;
            await this.directory.removeEntry(originalName).catch((error) => console.warn('Opus source cleanup deferred:', error));
          }
        } catch (error) {
          // An analysis/trim/quota failure must not destroy a completed recording.
          console.warn('Opus trim skipped; preserving the original recording:', error);
          trimStats.trimWarning = 'Silence trim failed; saved without trimming. / 無音トリムに失敗したため、録音全体を保存しました。';
        }
      }
      const result = {
        stats: {
          capturedSeconds: this.elapsedSeconds(),
          savedSeconds: this.elapsedSeconds(),
          leadingTrimSeconds: 0,
          trailingTrimSeconds: 0,
          foundAudio: true,
          ...trimStats,
          sampleRate: this.context.sampleRate,
          recordingFormat: this.recordingFormat,
          targetBitrate: this.targetBitrate,
          fileSize: file.size,
          filename: this.filename
        },
        file,
        temporary: { directory: this.directory, name: this.fileName }
      };
      return result;
    } catch (error) {
      await this.discard();
      throw error;
    }
  }

  async _trimFile(file) {
    const name = `opus-${Date.now()}-${crypto.randomUUID().slice(0, 12)}.webm`;
    let worker;
    let watchdog;
    try {
      worker = new Worker(chrome.runtime.getURL('opus-trim-worker.js'));
      const result = await new Promise((resolve, reject) => {
        const keepAlive = () => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => reject(new Error('Opus trim worker stopped responding.')), 60000);
        };
        worker.onmessage = ({ data }) => {
          keepAlive();
          if (data.type === 'complete') resolve(data);
          else if (data.type === 'error') reject(new Error(data.error));
        };
        worker.onerror = (event) => {
          event.preventDefault();
          reject(new Error(event.message || 'Opus trim worker failed.'));
        };
        worker.onmessageerror = () => reject(new Error('Opus trim worker response could not be read.'));
        keepAlive();
        worker.postMessage({ file, directory: this.directory, outputName: name, boundaries: this.boundaries });
      });
      return { ...result, name };
    } catch (error) {
      worker?.terminate();
      await this.directory.removeEntry(name).catch(() => {});
      throw error;
    } finally {
      clearTimeout(watchdog);
      worker?.terminate();
    }
  }

  async discard() {
    this.stopRequested = true;
    if (this.progressTimer !== null) clearInterval(this.progressTimer);
    this.progressTimer = null;
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch {}
    }
    try { await this.writeChain; } catch {}
    if (this.writable) {
      try { await this.writable.abort(); } catch {}
      this.writable = null;
    }
    if (this.directory && this.fileName) {
      try { await this.directory.removeEntry(this.fileName); } catch {}
    }
    this._releaseGraph();
  }

  _releaseGraph() {
    if (this.analyser) {
      this.analyser.port.onmessage = null;
      this.analyser.port.close();
      this.analyser.onprocessorerror = null;
      this.analyser = null;
    }
    if (this.tap) {
      try { this.outputNode.disconnect(this.tap); } catch {}
    }
    for (const node of this.nodes) {
      try { node.disconnect(); } catch {}
    }
    for (const track of (this.destination?.stream?.getTracks() || [])) {
      if (track.readyState !== 'ended') track.stop();
    }
    this.nodes = [];
    this.tap = null;
    this.destination = null;
    this.recorder = null;
  }
}

// Clean up only stale, extension-owned temporary files after one week. Recent
// files are kept in case Chrome was interrupted during a download.
async function cleanupStaleOpusFiles(activeNames = new Set()) {
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(OPUS_TEMP_DIRECTORY, { create: true });
    const now = Date.now();
    for await (const [name] of directory.entries()) {
      const match = /^opus-(\d{13})-[a-f0-9-]+\.webm$/.exec(name);
      if (match && !activeNames.has(name) && now - Number(match[1]) > OPUS_TEMP_RETENTION_MS) {
        await directory.removeEntry(name).catch(() => {});
      }
    }
  } catch (error) {
    console.debug('Temporary Opus cleanup skipped:', error);
  }
}
