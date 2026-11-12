'use strict';
importScripts('webm-opus.js');

// The decoder queue is bounded, AudioData is closed immediately, and only the
// first/last sustained active block is retained. No recording-length PCM/RMS array.
class BoundaryDetector {
  constructor(settings) {
    this.blockFrames = Math.round(48000 * settings.analysisBlockMs / 1000);
    this.threshold = 10 ** (settings.thresholdDb / 20);
    this.minBlocks = Math.ceil(settings.minimumActiveMs / settings.analysisBlockMs);
    this.settings = settings;
    this.cursor = 0;
    this.block = 0;
    this.count = 0;
    this.sums = [0, 0];
    this.run = 0;
    this.first = -1;
    this.last = -1;
  }
  finishBlock() {
    if (!this.count) return;
    const rms = Math.sqrt(Math.max(...this.sums) / this.count);
    this.run = rms >= this.threshold ? this.run + 1 : 0;
    if (this.run >= this.minBlocks) {
      if (this.first < 0) this.first = this.block - this.run + 1;
      this.last = this.block;
    }
    this.block += 1;
    this.count = 0;
    this.sums = [0, 0];
  }
  add(planes, startFrame, validEndFrame) {
    for (let i = Math.max(0, -startFrame, this.cursor - startFrame); i < planes[0].length; i += 1) {
      const frame = startFrame + i;
      if (frame >= validEndFrame) break;
      const block = Math.floor(frame / this.blockFrames);
      if (block > this.block) {
        this.finishBlock();
        if (block > this.block) this.run = 0;
        this.block = block;
      }
      this.count = frame % this.blockFrames + 1;
      for (let channel = 0; channel < planes.length; channel += 1) {
        const sample = Math.max(-1, Math.min(1, planes[channel][i] || 0));
        this.sums[channel] += sample * sample;
      }
      this.cursor = frame + 1;
      if (this.count === this.blockFrames) this.finishBlock();
    }
  }
  result(duration) {
    this.finishBlock();
    const foundAudio = this.first >= 0;
    const start = foundAudio ? Math.max(0, this.first * this.blockFrames / 48000 - this.settings.leadingPaddingMs / 1000) : 0;
    const end = foundAudio ? Math.min(duration, (this.last + 1) * this.blockFrames / 48000 + this.settings.trailingPaddingMs / 1000) : duration;
    return { start, end, foundAudio, capturedSeconds: duration, savedSeconds: end - start,
      leadingTrimSeconds: start, trailingTrimSeconds: Math.max(0, duration - end) };
  }
}

async function analyze(meta, settings) {
  if (!globalThis.AudioDecoder) throw new Error('Opus silence analysis requires AudioDecoder.');
  // Handle pre-skip ourselves, consistently across Chrome versions.
  const description = meta.privateData.slice();
  new DataView(description.buffer).setUint16(10, 0, true);
  const config = { codec: 'opus', sampleRate: 48000, numberOfChannels: meta.channels, description };
  if (!(await AudioDecoder.isConfigSupported(config)).supported) throw new Error('Opus decoder is unavailable.');
  const detector = new BoundaryDetector(settings);
  let error;
  let duration = 0;
  let batch = [];
  let submitted = 0;
  const decoder = new AudioDecoder({
    output(data) {
      try {
        if (data.sampleRate !== 48000 || data.numberOfChannels !== meta.channels) throw new Error('Unexpected decoded Opus format.');
        const planes = Array.from({ length: data.numberOfChannels }, (_, planeIndex) => {
          const plane = new Float32Array(data.numberOfFrames);
          data.copyTo(plane, { planeIndex, format: 'f32-planar' });
          return plane;
        });
        // Decoders may smooth input timestamps. Map decoded samples in order to
        // their source packets instead of relying on the decoder's clock policy.
        let offset = 0;
        while (offset < data.numberOfFrames) {
          const source = batch[0];
          if (!source) throw new Error('Unexpected Opus decoder frame count.');
          const frames = Math.min(data.numberOfFrames - offset, source.frames - source.consumed);
          const start = Math.round((source.timestampNs - meta.delayNs) * 48000 / 1e9) + source.consumed;
          detector.add(planes.map((plane) => plane.subarray(offset, offset + frames)), start,
            Math.round(source.validEndNs * 48000 / 1e9));
          source.consumed += frames;
          offset += frames;
          if (source.consumed === source.frames) batch.shift();
        }
      } catch (reason) { error ||= reason; }
      finally { data.close(); }
    },
    error(reason) { error ||= reason; }
  });
  try {
    decoder.configure(config);
    for await (const packet of WebMOpus.packets(meta)) {
      if (error) throw error;
      if (packet.paddingNs < 0) throw new Error('Unsupported leading block padding.');
      const timestamp = Math.round(packet.timestampNs / 1000);
      const validEndNs = packet.timestampNs + packet.durationNs - meta.delayNs - packet.paddingNs;
      duration = Math.max(duration, validEndNs / 1e9);
      batch.push({ timestampNs: packet.timestampNs, frames: Math.round(packet.durationNs * 48000 / 1e9), consumed: 0, validEndNs });
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: packet.data }));
      if (++submitted >= 16) {
        await decoder.flush();
        if (error) throw error;
        if (batch.length) throw new Error('Opus decoder did not return all samples.');
        submitted = 0;
        self.postMessage({ type: 'progress' });
      }
    }
    await decoder.flush();
    if (error) throw error;
    if (batch.length) throw new Error('Opus decoder ended before returning all samples.');
    if (!duration) throw new Error('No decoded Opus audio.');
    return detector.result(duration);
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
}

self.onmessage = async ({ data }) => {
  let writable;
  let created = false;
  try {
    const meta = await WebMOpus.inspect(data.file);
    const stats = await analyze(meta, data.settings);
    if (stats.leadingTrimSeconds < 1 / 48000 && stats.trailingTrimSeconds < 1 / 48000) {
      self.postMessage({ type: 'complete', stats, unchanged: true });
      return;
    }
    const handle = await data.directory.getFileHandle(data.outputName, { create: true });
    created = true;
    writable = await handle.createWritable();
    await WebMOpus.remux(meta, { write: async (chunk) => {
      await writable.write(chunk);
      self.postMessage({ type: 'progress' });
    } }, stats.start, stats.end);
    await writable.close();
    writable = null;
    const file = await handle.getFile();
    self.postMessage({ type: 'complete', stats, file });
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    if (created) await data.directory.removeEntry(data.outputName).catch(() => {});
    self.postMessage({ type: 'error', error: error?.message || String(error) });
  }
};
