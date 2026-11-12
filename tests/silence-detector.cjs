const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const PCM = require('../sound-fx-and-recorder/pcm-utils.js');
const source = fs.readFileSync(path.join(__dirname, '../sound-fx-and-recorder/silence-detector-worklet.js'), 'utf8');
const settings = { thresholdDb: -55, analysisBlockMs: 20, minimumActiveMs: 60, leadingPaddingMs: 250, trailingPaddingMs: 500 };

for (const rate of [44100, 48000, 96000]) {
  for (const scenario of ['pauses', 'silence', 'short', 'threshold', 'immediate', 'partial', 'delayed']) {
    let Processor;
    let message;
    const scope = vm.createContext({ sampleRate: rate, currentFrame: 0,
      AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => { message = data; } }; } },
      registerProcessor: (name, value) => { Processor = value; }
    });
    vm.runInContext(source, scope);
    const worklet = new Processor();
    const start = () => worklet.port.onmessage({ data: { type: 'start', startFrame: 0, settings } });
    if (scenario !== 'delayed') start();
    const frames = Math.round(rate * (scenario === 'partial' ? 1.079 : 7));
    const blockFrames = Math.round(rate * .02);
    const levels = [];
    let count = 0, leftSum = 0, rightSum = 0;
    const addLevel = () => { levels.push(Math.sqrt(Math.max(leftSum, rightSum) / count)); count = 0; leftSum = rightSum = 0; };
    const params = { levels, blockFrames, sampleRate: rate, ...settings };
    const sample = (t, channel) => {
      if (scenario === 'silence') return 0;
      if (scenario === 'short') return t >= .4 && t < .42 ? .2 : 0;
      if (scenario === 'immediate') return .2;
      if (scenario === 'delayed') return t < .1 || (t >= 6 && t < 6.1) ? .2 : 0;
      if (scenario === 'partial') return t >= 1 ? .2 : 0;
      if (scenario === 'threshold') return channel === 0 ? 0 : t < 2 ? 10 ** (-55.1 / 20) : t < 4 ? 10 ** (-54.9 / 20) : 0;
      return (t >= 1.5 && t < 2.5) || (t >= 3.5 && t < 4.5) ? (channel ? -.3 : .2) : 0;
    };
    for (let offset = 0; offset < frames; offset += 128) {
      const length = Math.min(128, frames - offset);
      const left = new Float32Array(length), right = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        left[i] = sample((offset + i) / rate, 0); right[i] = sample((offset + i) / rate, 1);
        leftSum += left[i] ** 2; rightSum += right[i] ** 2;
        if (++count === blockFrames) addLevel();
      }
      scope.currentFrame = offset;
      if (scenario === 'delayed' && offset === 4096) start();
      worklet.process([[left, right]]);
      if (scenario === 'delayed' && offset < 4096) continue;
      worklet.port.onmessage({ data: { type: 'snapshot' } });
      const expected = PCM.computeEstimatedSavedFrames({ ...params, processedFrames: offset + length });
      assert.ok(Math.abs(message.savedSeconds - expected.savedFrames / rate) < 1 / rate, `${rate}/${scenario}: live estimate`);
      assert.equal(message.error, '');
    }
    if (count) addLevel();
    worklet.port.onmessage({ data: { type: 'stop' } });
    const expected = PCM.computeBoundaryTrim({ ...params, totalFrames: frames });
    assert.equal(message.foundAudio, expected.foundAudio);
    assert.ok(Math.abs(message.start - expected.startFrame / rate) < 1 / rate);
    assert.ok(Math.abs(message.end - expected.endFrame / rate) < 1 / rate);
    assert.ok(!Object.values(worklet).some(value => Array.isArray(value) || ArrayBuffer.isView(value)), 'no PCM/RMS history arrays');
    console.log('PASS WAV boundary/display parity', rate, scenario);
  }
}
