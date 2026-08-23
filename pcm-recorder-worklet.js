const BUFFER_FRAMES = 4096;
const OUTPUT_CHANNELS = 2;

class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.recording = false;
    this.resetBuffers();

    this.port.onmessage = (event) => {
      const type = event.data?.type;

      if (type === 'start-recording') {
        this.recording = false;
        this.resetBuffers();
        this.recording = true;
        this.port.postMessage({ type: 'recording-started' });
        return;
      }

      if (type === 'stop-and-flush') {
        this.recording = false;
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    for (let channel = 0; channel < output.length; channel += 1) {
      const destination = output[channel];
      const source = input.length > 0
        ? input[Math.min(channel, input.length - 1)]
        : null;

      if (source) destination.set(source);
      else destination.fill(0);
    }

    if (!this.recording || output.length === 0) return true;

    const leftIn = output[0];
    const rightIn = output[1] || output[0];
    let sourceIndex = 0;

    while (sourceIndex < leftIn.length) {
      const writable = Math.min(
        BUFFER_FRAMES - this.writeIndex,
        leftIn.length - sourceIndex
      );

      this.left.set(
        leftIn.subarray(sourceIndex, sourceIndex + writable),
        this.writeIndex
      );
      this.right.set(
        rightIn.subarray(sourceIndex, sourceIndex + writable),
        this.writeIndex
      );

      this.writeIndex += writable;
      sourceIndex += writable;

      if (this.writeIndex === BUFFER_FRAMES) {
        this.emitBuffer(BUFFER_FRAMES);
      }
    }

    return true;
  }

  resetBuffers() {
    this.writeIndex = 0;
    this.left = new Float32Array(BUFFER_FRAMES);
    this.right = new Float32Array(BUFFER_FRAMES);
  }

  emitBuffer(frameCount) {
    if (frameCount <= 0) return;

    const leftChunk = frameCount === BUFFER_FRAMES
      ? this.left
      : this.left.slice(0, frameCount);
    const rightChunk = frameCount === BUFFER_FRAMES
      ? this.right
      : this.right.slice(0, frameCount);

    this.port.postMessage(
      {
        type: 'pcm',
        left: leftChunk,
        right: rightChunk,
        frames: frameCount
      },
      [leftChunk.buffer, rightChunk.buffer]
    );

    this.resetBuffers();
  }

  flush() {
    if (this.writeIndex > 0) this.emitBuffer(this.writeIndex);
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
