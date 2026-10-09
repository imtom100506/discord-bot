const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createNeuralSpeech } = require('../src/neuralSpeech');

function fixture(timeoutMs = 1000) {
  const children = [];
  const speech = createNeuralSpeech({ timeoutMs, spawn: () => {
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; child.emit('exit'); };
    child.send = msg => { child.request = msg; };
    children.push(child);
    return child;
  } });
  return { speech, children };
}
test('model process is reused for replies and released on exit', async () => {
  const { speech, children } = fixture();
  const warm = speech.warm(); children[0].emit('message', { ready: true }); await warm;
  for (let i = 0; i < 2; i++) {
    const result = speech.synthesize('Listo.', new AbortController().signal);
    await new Promise(setImmediate);
    children[0].emit('message', { id: children[0].request.id, audio: Buffer.from('wav') });
    assert.equal((await result).toString(), 'wav');
  }
  assert.equal(children.length, 1);
  speech.close(); assert.equal(children[0].killed, true);
});
test('slow generation is killed and next session can start fresh', async () => {
  const { speech, children } = fixture(30);
  const warm = speech.warm(); children[0].emit('message', { ready: true }); await warm;
  await assert.rejects(speech.synthesize('Listo.', new AbortController().signal), /demasiado lenta/);
  assert.equal(children[0].killed, true);
  const next = speech.warm(); children[1].emit('message', { ready: true }); await next;
  speech.close();
});
test('abort while loading cancels the worker', async () => {
  const { speech, children } = fixture(); const controller = new AbortController();
  const pending = speech.synthesize('Listo.', controller.signal);
  controller.abort(); await assert.rejects(pending);
  assert.equal(children[0].killed, true);
});
