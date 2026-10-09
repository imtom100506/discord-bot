const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { startWakeListener, createWakeFactory } = require('../src/wakeListener');

function fixture() {
  const inputs = new Map(), detected = [], timers = new Set();
  let released = 0, failed = 0, allowed = true;
  const receiver = { speaking: new EventEmitter(), subscribe: id => {
    const input = new PassThrough(); inputs.set(id, input); return input;
  } };
  const listener = startWakeListener({ receiver, api: { EndBehaviorType: { AfterSilence: 1 } },
    decoderFactory: () => new PassThrough(), eligible: () => allowed,
    detectorFactory: () => ({ frameLength: 2, process: frame => frame[0] === 42 ? 0 : -1, release: () => { released++; } }),
    onWake: (id, source) => { detected.push({ id, source }); }, onError: () => { failed++; },
    setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn) });
  return { listener, receiver, inputs, detected, timers, get released() { return released; },
    get failed() { return failed; }, pause: () => { allowed = false; } };
}
test('background speech never activates; split frames retain question bytes after wake', () => {
  const f = fixture(); f.receiver.speaking.emit('start', 'a');
  const input = f.inputs.get('a');
  input.write(Buffer.alloc(8)); assert.equal(f.detected.length, 0);
  input.write(Buffer.from([42])); assert.equal(f.detected.length, 0);
  input.write(Buffer.from([0, 0, 0, 7, 8]));
  assert.equal(f.detected.length, 1); assert.equal(f.detected[0].id, 'a');
  assert.deepEqual(f.detected[0].source.initial, Buffer.from([7, 8]));
  assert.equal(f.released, 1); assert.equal(input.destroyed, false);
  f.detected[0].source.input.destroy(); f.detected[0].source.decoder.destroy(); f.listener.stop();
});
test('speaker cap, pause and stop release resources and prevent new subscriptions', () => {
  const f = fixture();
  for (const id of ['a', 'b', 'c']) f.receiver.speaking.emit('start', id);
  assert.equal(f.inputs.size, 2);
  f.listener.pause(); assert.equal(f.released, 2);
  assert.ok([...f.inputs.values()].every(s => s.destroyed));
  assert.equal(f.timers.size, 0);
  f.listener.stop(); f.receiver.speaking.emit('start', 'c');
  assert.equal(f.inputs.size, 2); assert.equal(f.receiver.speaking.listenerCount('start'), 0);
});
test('no capture during response/cooldown; stream error disables wake listener', () => {
  const f = fixture(); f.receiver.speaking.emit('start', 'a');
  f.inputs.get('a').emit('error', Error('audio')); assert.equal(f.failed, 1);
  assert.equal(f.receiver.speaking.listenerCount('start'), 0);
  const g = fixture(); g.pause(); g.receiver.speaking.emit('start', 'a');
  assert.equal(g.inputs.size, 0); g.listener.stop();
});
test('local detector requires no account; disabled mode loads nothing', () => {
  assert.equal(createWakeFactory({}), null);
  assert.equal(typeof createWakeFactory({ TARS_WAKE_ENABLED: 'true' }), 'function');
});
