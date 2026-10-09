const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createVoice, IDLE_MS, MAX_AUDIO_BYTES } = require('../src/voice');
const { createUsageBudget } = require('../src/usageBudget');
const { wav, createVoiceAudio } = require('../src/voiceAudio');

test('budget persists reservations, serializes callers and survives restart', async () => {
  let data, time = 1000;
  const store = { read: async () => data, write: async value => { data = value; } };
  const budget = createUsageBudget({ store, now: () => time, dailyRequests: 2 });
  await Promise.all([budget.reserve({ tokens: 12 }), budget.reserve({ audio: 10 })]);
  const restarted = createUsageBudget({ store, now: () => time, dailyRequests: 2 });
  await assert.rejects(restarted.reserve(), { code: 'AI_BUDGET' });
  time += 86400001;
  await restarted.reserve();
  assert.equal(JSON.parse(data).length, 1);
});

test('budget refuses corrupt storage and write failures', async () => {
  const broken = createUsageBudget({ store: { read: async () => '{}', write: async () => {} } });
  await assert.rejects(broken.reserve(), { code: 'AI_BUDGET' });
  const unavailable = createUsageBudget({ store: { read: async () => null, write: async () => { throw Error(); } } });
  await assert.rejects(unavailable.reserve(), { code: 'AI_BUDGET' });
});

test('silent capture costs nothing; actual transcription reserves before request and handles 429', async () => {
  const calls = [];
  const audio = createVoiceAudio({ env: { GROQ_API_KEY: 'test' }, now: () => 1000,
    budget: { reserve: async value => calls.push(value) }, fetchImpl: async () => {
      calls.push('fetch'); return new Response('{}', { status: 429, headers: { 'retry-after': '60' } });
    } });
  const signal = new AbortController().signal;
  assert.equal(await audio.transcribe(Buffer.alloc(32000), signal), '');
  assert.equal(calls.length, 0);
  const pcm = Buffer.alloc(32000);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  await assert.rejects(audio.transcribe(pcm, signal));
  assert.deepEqual(calls, [{ audio: 10 }, 'fetch']);
  await assert.rejects(audio.transcribe(pcm, signal));
  assert.equal(calls.length, 2);
  assert.equal(wav(pcm).readUInt32LE(24), 16000);
});

test('neural TTS has bounded runtime and falls back locally without a network request', async () => {
  const calls = [];
  const audio = createVoiceAudio({ env: { TARS_TTS_ENGINE: 'piper' },
    fetchImpl: async () => { throw Error('unexpected network'); },
    runImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      if (calls.length === 1) throw Error('timeout');
      return { stdout: Buffer.from('wav') };
    } });
  assert.equal((await audio.synthesize('Misión lista.', new AbortController().signal)).toString(), 'wav');
  assert.equal(calls[0].options.timeout, 45000);
  assert.equal(calls[0].options.env.OMP_NUM_THREADS, '1');
  assert.ok(calls[1].args.includes('es-419+m3'));
});

test('leaving during neural speech generation prevents fallback', async () => {
  const abort = new AbortController(); let calls = 0;
  const audio = createVoiceAudio({ env: {}, runImpl: async () => { calls++; abort.abort(); throw Error('cancelled'); } });
  await assert.rejects(audio.synthesize('Misión lista.', abort.signal));
  assert.equal(calls, 1);
});

function fixture(overrides = {}) {
  let time = 0, destroyed = 0, subscriptions = 0, transcriptions = 0, capture;
  const timers = new Set(), replies = [];
  const connection = new EventEmitter();
  connection.destroy = () => { destroyed++; };
  connection.subscribe = () => {};
  connection.receiver = { subscribe: id => { assert.equal(id, 'human'); subscriptions++; capture = new PassThrough(); return capture; } };
  connection.receiver.speaking = new EventEmitter();
  const player = new EventEmitter(); player.stop = () => {}; player.play = () => {};
  const api = { joinVoiceChannel: () => connection, createAudioPlayer: () => player,
    entersState: async () => {}, VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected' },
    AudioPlayerStatus: { Playing: 'playing', Idle: 'idle' }, EndBehaviorType: { AfterSilence: 1 } };
  const guild = { id: 'guild', members: { fetch: async () => ({ voice: { channel } }), me: {} } };
  const channel = { id: 'voice', type: 2, guild, permissionsFor: () => ({ has: () => true }), members: new Map([['human', { user: { bot: false } }]]) };
  const ctx = { guild, user: { id: 'human' }, channel: { send: async value => replies.push(value.content) }, reply: async value => replies.push(value) };
  const voice = createVoice({ enabled: true, client: { user: { id: 'bot' } }, api,
    wakeFactory: overrides.wakeFactory,
    askAI: async () => { throw Error('not expected'); }, decoderFactory: () => new PassThrough(),
    audio: { check: async () => {}, transcribe: overrides.transcribe || (async pcm => { transcriptions++; assert.ok(pcm.length <= MAX_AUDIO_BYTES); return ''; }) },
    now: () => time, setTimer: (fn, delay) => { const timer = { fn, deadline: time + delay }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer) });
  async function advance(ms) {
    time += ms;
    for (const t of [...timers]) if (t.deadline <= time) { timers.delete(t); t.fn(); }
    await new Promise(resolve => setImmediate(resolve));
  }
  return { voice, ctx, advance, replies, receiver: connection.receiver, get capture() { return capture; }, get destroyed() { return destroyed; },
    get subscriptions() { return subscriptions; }, get transcriptions() { return transcriptions; } };
}

test('no background reception and leaves at ten minutes', async () => {
  const f = fixture(); await f.voice.handle(f.ctx, 'entrar');
  assert.equal(f.subscriptions, 0);
  await f.advance(IDLE_MS - 1); assert.equal(f.destroyed, 0);
  await f.advance(1); assert.equal(f.destroyed, 1);
});

test('explicit invocation resets timer; exit cancels capture without API', async () => {
  const f = fixture(); await f.voice.handle(f.ctx, 'entrar');
  await f.advance(IDLE_MS - 1000);
  const pending = f.voice.handle(f.ctx, 'escuchar');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.subscriptions, 1);
  await f.advance(1100); assert.equal(f.destroyed, 0);
  await f.voice.handle(f.ctx, 'salir'); await pending;
  assert.equal(f.transcriptions, 0); assert.equal(f.destroyed, 1); assert.ok(f.capture.destroyed);
});

test('capture is bounded and silence releases receiver', async () => {
  const f = fixture(); await f.voice.handle(f.ctx, 'entrar');
  const pending = f.voice.handle(f.ctx, 'escuchar');
  await new Promise(resolve => setImmediate(resolve));
  f.capture.end(Buffer.alloc(MAX_AUDIO_BYTES + 100)); await pending;
  assert.equal(f.transcriptions, 1); assert.ok(f.capture.destroyed);
  await f.voice.handle(f.ctx, 'escuchar');
  assert.equal(f.subscriptions, 1); // cooldown does not capture or reset idle
  await f.advance(IDLE_MS); assert.equal(f.destroyed, 1);
});

test('inactivity waits for the in-flight response then disconnects', async () => {
  let finish;
  const f = fixture({ transcribe: () => new Promise(resolve => { finish = resolve; }) });
  await f.voice.handle(f.ctx, 'entrar');
  const pending = f.voice.handle(f.ctx, 'escuchar');
  await new Promise(resolve => setImmediate(resolve));
  f.capture.end(Buffer.alloc(16000));
  await new Promise(resolve => setImmediate(resolve));
  await f.advance(IDLE_MS);
  assert.equal(f.destroyed, 0);
  finish(''); await pending;
  assert.equal(f.destroyed, 1);
});

test('empty channel disconnects immediately', async () => {
  const f = fixture(); await f.voice.handle(f.ctx, 'entrar');
  const member = await f.ctx.guild.members.fetch();
  member.voice.channel.members.clear();
  f.voice.onVoiceState({ guild: f.ctx.guild }, { id: 'human', channelId: null });
  assert.equal(f.destroyed, 1);
});

test('wake mode has a fixed deadline even during a manual capture', async () => {
  const f = fixture({ wakeFactory: () => ({ release() {} }) });
  await f.voice.handle(f.ctx, 'entrar');
  await f.advance(IDLE_MS - 1000);
  const pending = f.voice.handle(f.ctx, 'escuchar');
  await new Promise(resolve => setImmediate(resolve));
  await f.advance(1000); await pending;
  assert.equal(f.destroyed, 1);
  assert.equal(f.transcriptions, 0);
});

test('invalid wake configuration falls back to working manual voice', async () => {
  const f = fixture({ wakeFactory: () => { throw Error('invalid key'); } });
  await f.voice.handle(f.ctx, 'entrar');
  assert.ok(f.replies.some(t => t.includes('Sigo en modo /escuchar')));
  const pending = f.voice.handle(f.ctx, 'escuchar');
  await new Promise(resolve => setImmediate(resolve));
  f.capture.end(Buffer.alloc(16000)); await pending;
  assert.equal(f.transcriptions, 1); f.voice.leave();
});

test('wake transfers only post-activation audio into the single question pipeline', async () => {
  const pcm = [];
  const f = fixture({
    wakeFactory: () => ({ frameLength: 2, process: frame => frame[0] === 42 ? 0 : -1, release() {} }),
    transcribe: async data => { pcm.push(data); return ''; },
  });
  await f.voice.handle(f.ctx, 'entrar');
  f.receiver.speaking.emit('start', 'human');
  f.capture.write(Buffer.alloc(8)); assert.equal(pcm.length, 0);
  f.capture.write(Buffer.from([42, 0, 0, 0, 7, 8]));
  f.capture.end(Buffer.from([9, 10]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.subscriptions, 1);
  assert.deepEqual(pcm, [Buffer.from([7, 8, 9, 10])]);
  f.voice.leave();
  assert.equal(f.receiver.speaking.listenerCount('start'), 0);
});
