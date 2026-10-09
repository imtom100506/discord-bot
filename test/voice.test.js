const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createVoice, IDLE_MS, FOLLOWUP_MS, MAX_AUDIO_BYTES } = require('../src/voice');
const { createUsageBudget } = require('../src/usageBudget');
const { wav, trimSpeech, createVoiceAudio } = require('../src/voiceAudio');

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

test('short quiet speech survives surrounding silence; brief clicks do not', () => {
  const pcm = Buffer.alloc(32000 * 3);
  for (let i = 32000; i < 32000 + 6400; i += 2) pcm.writeInt16LE(150, i);
  assert.equal(trimSpeech(pcm).length, 12800);
  const click = Buffer.alloc(32000); click.writeInt16LE(30000, 100);
  assert.equal(trimSpeech(click).length, 0);
  assert.equal(trimSpeech(Buffer.alloc(3)).length, 0);
});

test('neural TTS has bounded runtime and falls back locally without a network request', async () => {
  const calls = [];
  const audio = createVoiceAudio({ env: { TARS_TTS_ENGINE: 'piper' },
    neural: { synthesize: async () => { throw Error('timeout'); }, close() {} },
    fetchImpl: async () => { throw Error('unexpected network'); },
    runImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: Buffer.from('wav') };
    } });
  assert.equal((await audio.synthesize('Misión lista.', new AbortController().signal)).toString(), 'wav');
  assert.equal(calls[0].options.timeout, 10000);
  assert.ok(calls[0].args.includes('es-419+m3'));
});

test('leaving during neural speech generation prevents fallback', async () => {
  const abort = new AbortController(); let calls = 0;
  const audio = createVoiceAudio({ env: {},
    neural: { synthesize: async () => { calls++; abort.abort(); throw Error('cancelled'); } },
    runImpl: async () => { throw Error('unexpected fallback'); } });
  await assert.rejects(audio.synthesize('Misión lista.', abort.signal));
  assert.equal(calls, 1);
});

function fixture(overrides = {}) {
  let time = 0, destroyed = 0, subscriptions = 0, transcriptions = 0, capture;
  const timers = new Set(), replies = [];
  const connection = new EventEmitter();
  connection.destroy = () => { destroyed++; };
  connection.subscribe = () => {};
  const receiving = new Map();
  connection.receiver = { subscribe: id => {
    if (receiving.has(id)) return receiving.get(id);
    subscriptions++; capture = new PassThrough();
    const input = capture;
    receiving.set(id, input);
    input.once('close', () => receiving.delete(id));
    return input;
  } };
  connection.receiver.speaking = new EventEmitter();
  const player = new EventEmitter(); player.stop = () => {}; player.play = () => {};
  const api = { joinVoiceChannel: () => connection, createAudioPlayer: () => player,
    createAudioResource: () => ({ playStream: new PassThrough() }), StreamType: { Arbitrary: 'arbitrary' },
    entersState: overrides.entersState || (async () => {}), VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected' },
    AudioPlayerStatus: { Playing: 'playing', Idle: 'idle' }, EndBehaviorType: { AfterSilence: 1 } };
  const guild = { id: 'guild', members: { fetch: async () => ({ voice: { channel } }), me: {} } };
  const channel = { id: 'voice', type: 2, guild, permissionsFor: () => ({ has: () => true }), members: new Map([['human', { user: { bot: false } }]]) };
  const ctx = { guild, user: { id: 'human' }, channel: { send: async value => replies.push(value.content) }, reply: async value => replies.push(value) };
  const voice = createVoice({ enabled: true, client: { user: { id: 'bot' } }, api,
    wakeFactory: overrides.wakeFactory,
    recordConversation: overrides.recordConversation,
    askAI: overrides.askAI || (async () => { throw Error('not expected'); }), decoderFactory: () => new PassThrough(),
    audio: { check: async () => {}, synthesize: async () => Buffer.from('wav'), transcribe: overrides.transcribe || (async pcm => { transcriptions++; assert.ok(pcm.length <= MAX_AUDIO_BYTES); return ''; }) },
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

test('no background reception and leaves at five minutes', async () => {
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
  await f.advance(IDLE_MS); assert.equal(f.destroyed, 1);
});

test('inactivity disconnects even during a stalled response', async () => {
  let finish;
  const f = fixture({ transcribe: () => new Promise(resolve => { finish = resolve; }) });
  await f.voice.handle(f.ctx, 'entrar');
  const pending = f.voice.handle(f.ctx, 'escuchar');
  await new Promise(resolve => setImmediate(resolve));
  f.capture.end(Buffer.alloc(16000));
  await new Promise(resolve => setImmediate(resolve));
  await f.advance(IDLE_MS);
  assert.equal(f.destroyed, 1);
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

test('wake mode resets inactivity on a manual invocation', async () => {
  const f = fixture({ wakeFactory: () => ({ release() {} }) });
  await f.voice.handle(f.ctx, 'entrar');
  await f.advance(IDLE_MS - 1000);
  const pending = f.voice.handle(f.ctx, 'escuchar');
  await new Promise(resolve => setImmediate(resolve));
  await f.advance(1000);
  assert.equal(f.destroyed, 0);
  await f.advance(IDLE_MS); await pending;
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

test('wake and followup renew inactivity; followup expires and excludes other speakers', async () => {
  const pcm = [];
  const f = fixture({
    wakeFactory: () => ({ frameLength: 2, process: frame => frame[0] === 42 ? 0 : -1, release() {} }),
    transcribe: async data => { pcm.push(data); return 'Pregunta'; },
    askAI: async () => 'Respuesta breve.',
  });
  await f.voice.handle(f.ctx, 'entrar');
  assert.equal(f.replies[0], 'En línea. Di "Hey TARS" y tu consulta. Sesión activa mientras conversemos; se cerrará tras 5 minutos de inactividad.');
  await f.advance(IDLE_MS - 1000);
  f.receiver.speaking.emit('start', 'human');
  f.capture.end(Buffer.from([42, 0, 0, 0, 7, 8]));
  await f.advance(0);
  assert.equal(pcm.length, 1);
  await f.advance(2000); assert.equal(f.destroyed, 0);
  const member = await f.ctx.guild.members.fetch();
  member.voice.channel.members.set('other', { user: { bot: false } });
  f.receiver.speaking.emit('start', 'other');
  f.capture.end(Buffer.alloc(8)); await f.advance(0);
  assert.equal(pcm.length, 1);
  f.receiver.speaking.emit('start', 'human');
  f.capture.end(Buffer.from([7, 8, 9, 10])); await f.advance(0);
  assert.deepEqual(pcm[1], Buffer.from([7, 8, 9, 10]));
  await f.advance(FOLLOWUP_MS);
  f.receiver.speaking.emit('start', 'human');
  f.capture.end(Buffer.alloc(8)); await f.advance(0);
  assert.equal(pcm.length, 2);
  await f.advance(IDLE_MS - FOLLOWUP_MS - 1); assert.equal(f.destroyed, 0);
  await f.advance(1); assert.equal(f.destroyed, 1);
});

test('empty followup stays silent and preserves remaining conversation window', async () => {
  let questions = 0, answers = 0;
  const f = fixture({
    wakeFactory: () => ({ frameLength: 2, process: frame => frame[0] === 42 ? 0 : -1, release() {} }),
    transcribe: async () => ++questions === 2 ? '' : 'hola',
    askAI: async () => { answers++; return 'Hola.'; },
  });
  await f.voice.handle(f.ctx, 'entrar');
  f.receiver.speaking.emit('start', 'human');
  f.capture.end(Buffer.from([42, 0, 0, 0, 7, 8])); await f.advance(0);
  f.receiver.speaking.emit('start', 'human');
  f.capture.end(Buffer.alloc(8)); await f.advance(0);
  assert.equal(f.replies.length, 1);
  await f.advance(1000);
  f.receiver.speaking.emit('start', 'human');
  f.capture.end(Buffer.from([7, 8])); await f.advance(0);
  assert.equal(answers, 2); f.voice.leave();
});

test('budget pause stops new capture until retry time without disconnecting', async () => {
  const f = fixture({
    wakeFactory: () => ({ frameLength: 2, process: () => 0, release() {} }),
    transcribe: async () => { throw Object.assign(Error('Dame un momento.'), { code: 'AI_BUDGET', retryAfterMs: 60000 }); },
  });
  await f.voice.handle(f.ctx, 'entrar');
  f.receiver.speaking.emit('start', 'human'); f.capture.end(Buffer.alloc(8)); await f.advance(0);
  f.receiver.speaking.emit('start', 'human'); assert.equal(f.subscriptions, 1);
  await f.advance(60000);
  f.receiver.speaking.emit('start', 'human'); assert.equal(f.subscriptions, 2);
  assert.equal(f.destroyed, 0); f.voice.leave();
});

test('wake phrase alone allows the question after a short pause', async () => {
  let transcriptions = 0, answers = 0;
  const f = fixture({
    wakeFactory: () => ({ frameLength: 2, process: frame => frame[0] === 42 ? 0 : -1, release() {} }),
    transcribe: async () => ++transcriptions === 1 ? '' : 'hola',
    askAI: async () => { answers++; return 'Hola.'; },
  });
  await f.voice.handle(f.ctx, 'entrar');
  f.receiver.speaking.emit('start', 'human'); f.capture.end(Buffer.from([42, 0, 0, 0])); await f.advance(0);
  await f.advance(1500);
  f.receiver.speaking.emit('start', 'human'); f.capture.end(Buffer.from([7, 8])); await f.advance(0);
  assert.equal(answers, 1); assert.equal(f.replies.length, 1); f.voice.leave();
});

test('manual capture takes a live detector stream instead of subscribing to its destroyed cache entry', async () => {
  const received = [];
  const f = fixture({
    wakeFactory: () => ({ frameLength: 2, process: () => -1, release() {} }),
    transcribe: async pcm => { received.push(pcm); return ''; },
  });
  await f.voice.handle(f.ctx, 'entrar');
  f.receiver.speaking.emit('start', 'human');
  const live = f.capture;
  const pending = f.voice.handle(f.ctx, 'escuchar'); await f.advance(0);
  assert.equal(live.destroyed, false); assert.equal(f.subscriptions, 1);
  live.end(Buffer.from([7, 8, 9, 10])); await pending;
  assert.deepEqual(received, [Buffer.from([7, 8, 9, 10])]); f.voice.leave();
});

test('light voice is available while neural model loads, then neural voice resumes', async () => {
  let ready, neuralCalls = 0;
  const audio = createVoiceAudio({ env: {}, neural: {
    warm: () => new Promise(resolve => { ready = resolve; }),
    synthesize: async () => { neuralCalls++; return Buffer.from('neural'); }, close() {},
  }, runImpl: async () => ({ stdout: Buffer.from('light') }) });
  const loading = audio.warm();
  assert.equal((await audio.synthesize('Hola', new AbortController().signal)).toString(), 'light');
  ready(); await loading;
  assert.equal((await audio.synthesize('Hola', new AbortController().signal)).toString(), 'neural');
  assert.equal(neuralCalls, 1); audio.close();
});

test('conversation log reuses existing text even when answering is blocked', async () => {
  const records = []; let calls = 0;
  const f = fixture({ recordConversation: item => records.push(item), transcribe: async () => 'Hola',
    askAI: async () => { if (++calls === 2) throw Object.assign(Error('Pausa'), { code: 'AI_BUDGET' }); return 'En línea.'; } });
  await f.voice.handle(f.ctx, 'entrar');
  for (let i = 0; i < 2; i++) {
    const pending = f.voice.handle(f.ctx, 'escuchar'); await f.advance(0);
    f.capture.end(Buffer.alloc(16000)); await pending; await f.advance(0);
  }
  assert.deepEqual(records.map(item => [item.role, item.text]), [['user', 'Hola'], ['assistant', 'En línea.'], ['user', 'Hola']]);
  assert.equal(calls, 2); f.voice.leave();
});
