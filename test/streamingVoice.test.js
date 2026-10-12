const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createAI } = require('../src/aiClient');
const { createDeepgramStream } = require('../src/voice/deepgramStreaming');
const { createAudioMixerManager } = require('../src/voice/audioMixerManager');
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = obj => `data: ${JSON.stringify(obj)}\n\n`;

test('LLM emits the first sentence before completion; SSE handles fragmented UTF-8 and usage', async () => {
  let controller, request;
  const said = [], settled = [];
  const body = new ReadableStream({ start(c) { controller = c; } });
  const ai = createAI({ env: { GROQ_API_KEY: 'test' }, systemPrompt: '', fetchImpl: async (url, init) => { request = JSON.parse(init.body); return new Response(body); } });
  ai.setBudget({ reserve: async () => ({ settle: async n => settled.push(n) }) });
  const promise = ai.askAI('u', 'pregunta', { voice: true, voicePrompt: 'TARS', externalHistory: [], onSentence: text => said.push(text) });
  await tick();
  assert.equal(request.stream, true);
  const first = Buffer.from(event({ choices: [{ delta: { content: 'Sí. ' } }] }));
  const split = first.indexOf(Buffer.from('í')) + 1;
  controller.enqueue(first.subarray(0, split)); controller.enqueue(first.subarray(split));
  await tick(); assert.deepEqual(said, ['Sí.']);
  controller.enqueue(Buffer.from(event({ choices: [{ delta: { content: 'Segunda frase.' }, finish_reason: 'stop' }] }) + event({ usage: { total_tokens: 25 }, choices: [] }) + 'data: [DONE]\n\n')); controller.close();
  assert.equal(await promise, 'Sí. Segunda frase.'); assert.deepEqual(settled, [25]);
  assert.deepEqual(said, ['Sí.', 'Segunda frase.']);
});

test('failure after audible output never retries or switches provider', async () => {
  let calls = 0;
  const ai = createAI({ env: { GROQ_API_KEY: 'test', CLOUDFLARE_API_TOKEN: 'test', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) },
    fetchImpl: async () => { calls++; return new Response(event({ choices: [{ delta: { content: 'Una frase.' } }] })); } });
  const said = [];
  await assert.rejects(ai.askAI('u', 'a', { voice: true, onSentence: s => said.push(s) }), { code: 'AI_PARTIAL' });
  assert.deepEqual(said, ['Una frase.']); assert.equal(calls, 1);
});

test('voice has no artificial ten-second delay and does not wait behind a text request', async () => {
  let finishText; const calls = [];
  const ai = createAI({ env: { GROQ_API_KEY: 'test' }, systemPrompt: '', now: () => 1000,
    wait: async () => { throw Error('artificial spacing'); }, fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      if (calls.length === 1) await new Promise(r => { finishText = r; });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Hola.' }, finish_reason: 'stop' }] }));
    } });
  const text = ai.askAI('text', 'a'); await tick();
  await ai.askAI('u', 'a', { voice: true }); await ai.askAI('u', 'b', { voice: true });
  assert.equal(calls.length, 3); finishText(); await text;
});

function mockSocket() {
  const sockets = [];
  class Socket extends EventEmitter {
    constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.emit('open'); }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.emit('close', 1000); }
    terminate() { this.close(); }
    result(text, final = false, start = 0) { this.emit('message', JSON.stringify({ type: 'Results', start, is_final: final, channel: { alternatives: [{ transcript: text }] } })); }
  }
  return { Socket, sockets };
}

test('Deepgram reserves before opening, sends during speech and commits final revisions only', async () => {
  const { Socket, sockets } = mockSocket(); let reserved = false;
  const partials = [];
  const stream = createDeepgramStream({ key: 'test', WebSocket: Socket, budget: { reserve: async value => { assert.deepEqual(value, { audio: 12 }); assert.equal(sockets.length, 0); reserved = true; } }, onPartial: text => partials.push(text) });
  stream.write(Buffer.alloc(16000)); await tick(); assert.equal(reserved, true);
  const socket = sockets[0]; socket.open(); assert.ok(Buffer.isBuffer(socket.sent[0]));
  socket.result('mute'); socket.result('no mutees', true); socket.result('por favor', true, 1);
  assert.equal(partials[0], 'mute');
  const result = stream.finish(); assert.equal(JSON.parse(socket.sent.at(-1)).type, 'CloseStream');
  socket.emit('message', JSON.stringify({ type: 'Metadata' }));
  assert.equal(await result, 'no mutees por favor'); assert.equal(socket.readyState, 3);
});

test('Deepgram cancellation and budget rejection open no sockets; premature close rejects', async () => {
  const { Socket, sockets } = mockSocket();
  const a = createDeepgramStream({ key: 'test', WebSocket: Socket, budget: { reserve: async () => { throw Object.assign(Error('budget'), { code: 'AI_BUDGET' }); } } });
  await assert.rejects(a.finish(), { code: 'AI_BUDGET' }); assert.equal(sockets.length, 0);
  const b = createDeepgramStream({ key: 'test', WebSocket: Socket, budget: { reserve: async () => {} } }); b.cancel();
  await assert.rejects(b.finish(), { name: 'AbortError' }); await tick(); assert.equal(sockets.length, 0);
  const c = createDeepgramStream({ key: 'test', WebSocket: Socket, budget: { reserve: async () => {} } }); await tick(); sockets[0].emit('close', 1006);
  await assert.rejects(c.finish(), /antes de finalizar/);
});

test('mixer opens streaming only after half a second, propagates partials and bounds concurrent streams', async () => {
  const timers = new Set(), inputs = new Map(), opened = [], partials = [], utterances = [];
  const receiver = { speaking: new EventEmitter(), subscribe(id) { const stream = new PassThrough(); inputs.set(id, stream); return stream; } };
  const mixer = createAudioMixerManager({ receiver, api: { EndBehaviorType: { Manual: 0 } }, decoderFactory: () => new PassThrough(),
    eligible: () => true, vadFactory: () => ({ frameBytes: 1024, process: () => true, reset() {}, close() {} }), maxPending: 1,
    setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn), onPartial: (id, text) => partials.push([id, text]),
    createStreaming: ({ onPartial }) => { const writes = []; const stream = { write: b => writes.push(b), cancel() {}, finish: async () => 'final', writes }; opened.push(stream); onPartial('parcial'); return stream; },
    onUtterance: async item => utterances.push(item),
  });
  mixer.subscribe('a'); mixer.subscribe('b'); inputs.get('a').write(Buffer.alloc(8192)); assert.equal(opened.length, 0);
  inputs.get('a').write(Buffer.alloc(8192)); assert.equal(opened.length, 1); assert.equal(opened[0].writes[0].length, 16384);
  inputs.get('b').write(Buffer.alloc(18432)); assert.equal(opened.length, 1);
  assert.deepEqual(partials, [['a', 'parcial']]);
  for (const fn of [...timers]) fn(); await tick(); assert.equal(utterances.length, 1); assert.equal(utterances[0].userId, 'a');
  mixer.stop(); assert.equal(mixer.audioBuffers.size, 0); assert.equal(receiver.speaking.listenerCount('start'), 0);
});
