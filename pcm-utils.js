(function (global) {
  'use strict';

  function dbToLinear(db) {
    return Math.pow(10, db / 20);
  }

  function computeActivityParams({
    blockFrames,
    sampleRate,
    thresholdDb,
    minimumActiveMs
  }) {
    const threshold = dbToLinear(thresholdDb);
    const blockDurationMs = blockFrames * 1000 / sampleRate;
    const minActiveBlocks = Math.max(
      1,
      Math.ceil(minimumActiveMs / blockDurationMs)
    );

    return { threshold, blockDurationMs, minActiveBlocks };
  }

  function findFirstSustainedActive(levels, threshold, minActiveBlocks) {
    let runLength = 0;

    for (let i = 0; i < levels.length; i += 1) {
      if (levels[i] >= threshold) {
        runLength += 1;

        if (runLength >= minActiveBlocks) {
          return i - runLength + 1;
        }
      } else {
        runLength = 0;
      }
    }

    return -1;
  }

  function findLastSustainedActive(levels, threshold, minActiveBlocks) {
    let runLength = 0;

    for (let i = levels.length - 1; i >= 0; i -= 1) {
      if (levels[i] >= threshold) {
        runLength += 1;

        if (runLength >= minActiveBlocks) {
          return i + runLength - 1;
        }
      } else {
        runLength = 0;
      }
    }

    return -1;
  }

  function computeBoundaryTrim({
    levels,
    blockFrames,
    totalFrames,
    sampleRate,
    thresholdDb,
    minimumActiveMs,
    leadingPaddingMs,
    trailingPaddingMs
  }) {
    if (!Array.isArray(levels) || levels.length === 0 || totalFrames <= 0) {
      return {
        startFrame: 0,
        endFrame: Math.max(0, totalFrames),
        foundAudio: false,
        firstActiveBlock: -1,
        lastActiveBlock: -1
      };
    }

    const { threshold, minActiveBlocks } = computeActivityParams({
      blockFrames,
      sampleRate,
      thresholdDb,
      minimumActiveMs
    });

    const firstActiveBlock = findFirstSustainedActive(
      levels,
      threshold,
      minActiveBlocks
    );

    const lastActiveBlock = findLastSustainedActive(
      levels,
      threshold,
      minActiveBlocks
    );

    if (firstActiveBlock < 0 || lastActiveBlock < 0) {
      return {
        startFrame: 0,
        endFrame: totalFrames,
        foundAudio: false,
        firstActiveBlock,
        lastActiveBlock
      };
    }

    const leadingPaddingFrames = Math.round(
      sampleRate * leadingPaddingMs / 1000
    );
    const trailingPaddingFrames = Math.round(
      sampleRate * trailingPaddingMs / 1000
    );

    const firstActiveFrame = firstActiveBlock * blockFrames;
    const lastActiveFrameExclusive = Math.min(
      totalFrames,
      (lastActiveBlock + 1) * blockFrames
    );

    const startFrame = Math.max(
      0,
      firstActiveFrame - leadingPaddingFrames
    );

    const endFrame = Math.min(
      totalFrames,
      lastActiveFrameExclusive + trailingPaddingFrames
    );

    return {
      startFrame,
      endFrame: Math.max(startFrame, endFrame),
      foundAudio: true,
      firstActiveBlock,
      lastActiveBlock
    };
  }

  // Estimate the final saved WAV length while recording is still in progress.
  // The logic mirrors the boundary-trim rules:
  // - before the first sustained audio, estimated length = 0
  // - during playback, length grows with the recording
  // - after the last sustained audio, length keeps growing only until the
  //   configured trailing padding is exhausted, then it stops
  function computeEstimatedSavedFrames({
    levels,
    blockFrames,
    processedFrames,
    sampleRate,
    thresholdDb,
    minimumActiveMs,
    leadingPaddingMs,
    trailingPaddingMs
  }) {
    if (!Array.isArray(levels) || levels.length === 0 || processedFrames <= 0) {
      return {
        savedFrames: 0,
        foundAudio: false,
        startFrame: 0,
        cappedEndFrame: 0,
        firstActiveBlock: -1,
        lastActiveBlock: -1
      };
    }

    const { threshold, minActiveBlocks } = computeActivityParams({
      blockFrames,
      sampleRate,
      thresholdDb,
      minimumActiveMs
    });

    const firstActiveBlock = findFirstSustainedActive(
      levels,
      threshold,
      minActiveBlocks
    );

    if (firstActiveBlock < 0) {
      return {
        savedFrames: 0,
        foundAudio: false,
        startFrame: 0,
        cappedEndFrame: 0,
        firstActiveBlock,
        lastActiveBlock: -1
      };
    }

    const lastActiveBlock = findLastSustainedActive(
      levels,
      threshold,
      minActiveBlocks
    );

    if (lastActiveBlock < 0) {
      return {
        savedFrames: 0,
        foundAudio: false,
        startFrame: 0,
        cappedEndFrame: 0,
        firstActiveBlock,
        lastActiveBlock
      };
    }

    const leadingPaddingFrames = Math.round(
      sampleRate * leadingPaddingMs / 1000
    );
    const trailingPaddingFrames = Math.round(
      sampleRate * trailingPaddingMs / 1000
    );

    const startFrame = Math.max(
      0,
      firstActiveBlock * blockFrames - leadingPaddingFrames
    );

    const lastActiveFrameExclusive = Math.min(
      processedFrames,
      (lastActiveBlock + 1) * blockFrames
    );

    const cappedEndFrame = Math.min(
      processedFrames,
      lastActiveFrameExclusive + trailingPaddingFrames
    );

    return {
      savedFrames: Math.max(0, cappedEndFrame - startFrame),
      foundAudio: true,
      startFrame,
      cappedEndFrame,
      firstActiveBlock,
      lastActiveBlock
    };
  }

  function makeWavHeader({
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes
  }) {
    if (dataBytes > 0xFFFFFFFF - 36) {
      throw new Error('Recording is too large for a standard RIFF/WAV file.');
    }

    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;

    const buffer = new ArrayBuffer(44);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(view, 8, 'WAVE');

    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    writeAscii(view, 36, 'data');
    view.setUint32(40, dataBytes, true);

    return new Uint8Array(buffer);
  }

  function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  const api = {
    dbToLinear,
    computeActivityParams,
    findFirstSustainedActive,
    findLastSustainedActive,
    computeBoundaryTrim,
    computeEstimatedSavedFrames,
    makeWavHeader
  };

  global.PCMUtils = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(globalThis);
