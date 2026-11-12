'use strict';
importScripts('webm-opus.js');

// The AudioWorklet supplies the same boundaries used by the live duration display.
// Only encoded packet headers are scanned here; no decoder or PCM buffer is needed.
async function trimStats(meta, boundaries) {
  if (!boundaries || boundaries.error ||
      ![boundaries.start, boundaries.end, boundaries.capturedSeconds].every(Number.isFinite) ||
      boundaries.start < 0 || boundaries.end < boundaries.start || boundaries.capturedSeconds <= 0) {
    throw new Error(boundaries?.error || 'Missing live silence boundaries.');
  }
  let duration = 0;
  let count = 0;
  for await (const packet of WebMOpus.packets(meta)) {
    if (packet.paddingNs < 0) throw new Error('Unsupported leading block padding.');
    duration = Math.max(duration, (packet.timestampNs + packet.durationNs - meta.delayNs - packet.paddingNs) / 1e9);
    if (++count % 256 === 0) self.postMessage({ type: 'progress' });
  }
  // Allow encoder packet rounding and a few render quanta, not clock drift or gaps.
  if (!duration || Math.abs(duration - boundaries.capturedSeconds) > 0.25) {
    throw new Error('Opus and silence analysis durations do not agree.');
  }
  const foundAudio = boundaries.foundAudio === true;
  const start = foundAudio ? Math.min(duration, boundaries.start) : 0;
  const end = foundAudio ? Math.min(duration, boundaries.end) : duration;
  if (end <= start) throw new Error('No audio remains inside the live trim boundaries.');
  return { start, end, foundAudio, capturedSeconds: duration, savedSeconds: end - start,
    leadingTrimSeconds: start, trailingTrimSeconds: Math.max(0, duration - end) };
}

self.onmessage = async ({ data }) => {
  let writable;
  let created = false;
  try {
    const meta = await WebMOpus.inspect(data.file);
    const stats = await trimStats(meta, data.boundaries);
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
