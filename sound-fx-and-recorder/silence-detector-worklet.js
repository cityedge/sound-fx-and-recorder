// Analysis-only branch: outputs silence and retains counters during recording.
// A fixed 250 ms startup ring bridges asynchronous start messages, then is released.
// The monitor and MediaRecorder keep their existing direct audio connections.
class SilenceDetectorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.started = false;
    this.ready = false;
    this.historySize = Math.ceil(sampleRate * 0.25);
    this.historyLeft = new Float32Array(this.historySize);
    this.historyRight = new Float32Array(this.historySize);
    this.historyStart = Infinity;
    this.historyEnd = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') {
        this.settings = data.settings;
        this.origin = data.startFrame;
        this.blockFrames = Math.max(1, Math.round(sampleRate * data.settings.analysisBlockMs / 1000));
        this.thresholdSquared = 10 ** (data.settings.thresholdDb / 10);
        this.minBlocks = Math.ceil(data.settings.minimumActiveMs / data.settings.analysisBlockMs);
        this.frames = 0;
        this.block = 0;
        this.count = 0;
        this.leftSum = 0;
        this.rightSum = 0;
        this.run = 0;
        this.first = -1;
        this.lastEnd = 0;
        this.error = '';
        this.active = true;
        this.started = true;
        // Replay only samples at/after the requested MediaRecorder start frame.
        // Message delivery latency must not silently lose an initial short sound.
        if (this.historyEnd > this.origin) {
          if (this.origin < this.historyStart) this.error = 'Silence analysis start arrived too late.';
          else for (let frame = this.origin; frame < this.historyEnd; frame += 1) {
            const index = frame % this.historySize;
            this.addSample(this.historyLeft[index], this.historyRight[index]);
          }
        }
        this.historyLeft = null;
        this.historyRight = null;
      } else if (data.type === 'snapshot' && this.active) {
        this.port.postMessage({ type: 'snapshot', ...this.snapshot() });
      } else if (data.type === 'stop' && this.settings) {
        this.active = false;
        this.finishBlock();
        this.port.postMessage({ type: 'stopped', ...this.snapshot() });
      }
    };
  }

  finishBlock() {
    if (!this.count) return;
    this.run = Math.max(this.leftSum, this.rightSum) / this.count >= this.thresholdSquared ? this.run + 1 : 0;
    if (this.run >= this.minBlocks) {
      if (this.first < 0) this.first = this.block - this.run + 1;
      this.lastEnd = this.frames;
    }
    this.block += 1;
    this.count = 0;
    this.leftSum = 0;
    this.rightSum = 0;
  }

  snapshot() {
    const foundAudio = this.first >= 0;
    const duration = this.frames / sampleRate;
    const start = foundAudio ? Math.max(0, this.first * this.blockFrames / sampleRate - this.settings.leadingPaddingMs / 1000) : 0;
    const end = foundAudio ? Math.min(duration, this.lastEnd / sampleRate + this.settings.trailingPaddingMs / 1000) : duration;
    return { start, end, foundAudio, capturedSeconds: duration,
      savedSeconds: foundAudio ? end - start : 0, error: this.error };
  }

  addSample(left, right) {
    left = Math.max(-1, Math.min(1, left));
    right = Math.max(-1, Math.min(1, right));
    this.leftSum += left * left;
    this.rightSum += right * right;
    this.count += 1;
    this.frames += 1;
    if (this.frames % this.blockFrames === 0) this.finishBlock();
  }

  process(inputs, outputs = []) {
    // Output buffers stay zero. Reading this branch never changes recorded audio.
    const input = inputs[0];
    const length = input[0]?.length || outputs[0]?.[0]?.length || 128;
    if (!this.started) {
      if (this.historyEnd !== currentFrame) this.historyStart = currentFrame;
      this.historyStart = Math.max(Math.min(this.historyStart, currentFrame), currentFrame + length - this.historySize);
      for (let i = 0; i < length; i += 1) {
        const index = (currentFrame + i) % this.historySize;
        this.historyLeft[index] = input[0]?.[i] || 0;
        this.historyRight[index] = (input[1] || input[0])?.[i] || 0;
      }
      this.historyEnd = currentFrame + length;
      if (!this.ready) { this.ready = true; this.port.postMessage({ type: 'ready' }); }
      return true;
    }
    if (!this.active) return true;
    const offset = Math.max(0, this.origin - currentFrame);
    if (offset >= length) return true;
    const expected = currentFrame + offset - this.origin;
    if (expected !== this.frames) {
      this.error = 'Silence analysis sample clock was interrupted.';
    }
    for (let i = offset; i < length; i += 1) {
      this.addSample(input[0]?.[i] || 0, (input[1] || input[0])?.[i] || 0);
    }
    return true;
  }
}

registerProcessor('silence-detector', SilenceDetectorProcessor);
