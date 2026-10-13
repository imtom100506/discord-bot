const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createVoice } = require('../src/voice');
const { createContextManager } = require('../src/optimization/contextManager');
const tick = () => new Promise(resolve => setImmediate(resolve));
const pcm = (sample = 1000, bytes = 18432) => { const b = Buffer.alloc(bytes); for (let i = 0; i < bytes; i += 2) b.writeInt16LE(sample, i); return b; };

async function fixture(options = {}) {
  let time = 0, destroyed = false;
  const logs = [], plays = [];
  const timers = new Set(), input = new Map(), replies = [], said = [], requests = [], transcribed = [];
  const receiver = { speaking: new EventEmitter(), subscribe(id) { if (input.has(id) && !input.get(id).destroyed) return input.get(id); const stream = new PassThrough(); input.set(id, stream); return stream; } };
  const connection = new EventEmitter(); connection.receiver = receiver; connection.subscribe = () => {}; connection.destroy = () => { destroyed = true; }; connection.rejoin = () => true;
  const player = new EventEmitter(); player.play = resource => plays.push(resource); player.stop = () => {};
  const api = { joinVoiceChannel: () => connection, createAudioPlayer: () => player, createAudioResource: () => ({ playStream: new PassThrough(), volume: { setVolume() {} } }),
    entersState: options.entersState || (async () => {}), StreamType: { Arbitrary: 0 }, EndBehaviorType: { Manual: 0 }, VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'gone' }, AudioPlayerStatus: { Playing: 'playing', Idle: 'idle' } };
  const members = new Map([['alice', { displayName: 'Alicia', user: { bot: false } }], ['bob', { displayName: 'Roberto', user: { bot: false } }], ['bot', { user: { bot: true } }]]);
  const channel = { id: 'voice', type: 2, members, permissionsFor: () => ({ has: () => true }) };
  const guild = { id: 'guild', members: { me: {}, fetch: async () => ({ voice: { channel } }) } }; channel.guild = guild;
  const ctx = { guild, user: { id: 'alice' }, channel: { send: async payload => replies.push(payload) }, reply: async text => replies.push({ content: text }) };
  const memory = createContextManager({ persist: false });
  if (options.excluded) await memory.exclude('guild:voice', options.excluded, true);
  const voice = createVoice({ enabled: true, env: {}, client: { user: { id: 'bot' } }, api, memory, sendLog: (event, data) => logs.push({ event, ...data }),
    decoderFactory: () => new PassThrough(), vadFactory: () => ({ frameBytes: 1024, process: b => b.readInt16LE(0) !== 0, reset() {}, close() {} }),
    audio: { countdown: options.countdown || (async () => Buffer.from('countdown')), check: async () => {}, synthesize: async text => { said.push(text); if (options.synthesize) return options.synthesize(text); return Buffer.from('wav'); }, close() {}, transcribe: async (b, signal) => {
      transcribed.push(b); if (options.transcribe) return options.transcribe(b, signal);
      return b.readInt16LE(0) === 1000 ? 'TARS, ¿cómo funciona la gravedad?' : 'TARS, ¿qué es Marte?';
    } },
    askAI: async (id, text, opts) => { requests.push({ id, text, opts }); if (options.askAI) return options.askAI(id, text, opts); return 'Respuesta breve.'; },
    now: () => time, setTimer: (fn, delay) => { const timer = { fn, deadline: time + delay }; timers.add(timer); return timer; }, clearTimer: timer => timers.delete(timer) });
  async function advance(ms) { time += ms; for (const t of [...timers]) if (t.deadline <= time) { timers.delete(t); t.fn(); } for (let i = 0; i < 8; i++) await tick(); }
  await voice.handle(ctx, 'entrar');
  return { voice, ctx, input, logs, plays, timers, player, members, memory, requests, transcribed, said, replies, receiver, advance, get destroyed() { return destroyed; } };
}

test('global join announces aloud and receives simultaneous speakers with distinct identities', async () => {
  const f = await fixture();
  assert.equal(f.said[0], 'Escuchando a todo el canal');
  assert.deepEqual([...f.input.keys()], ['alice', 'bob']);
  f.input.get('alice').write(pcm(1000)); f.input.get('bob').write(pcm(2000));
  await f.advance(240);
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[0].text, /\[Usuario: Alicia\] dijo:/);
  assert.match(f.requests[1].text, /\[Usuario: Roberto\] dijo:/);
  assert.equal(f.transcribed[0].readInt16LE(0), 1000); assert.equal(f.transcribed[1].readInt16LE(0), 2000);
  assert.ok(f.requests[1].opts.externalHistory.some(m => /Alicia/.test(m.content)));
  f.voice.leave(); assert.equal(f.receiver.speaking.listenerCount('start'), 0);
});

test('new members subscribe through voiceStateUpdate and speaking/start without duplicates or bots', async () => {
  const f = await fixture();
  f.members.set('new', { user: { bot: false } });
  f.voice.onVoiceState({ guild: f.ctx.guild, channelId: null }, { id: 'new', channelId: 'voice' });
  const original = f.input.get('new'); assert.ok(original);
  f.receiver.speaking.emit('start', 'new'); assert.equal(f.input.get('new'), original);
  f.members.set('late', { user: { bot: false } }); f.receiver.speaking.emit('start', 'late'); assert.ok(f.input.get('late'));
  f.receiver.speaking.emit('start', 'bot'); assert.equal(f.input.has('bot'), false);
  f.members.delete('new'); f.voice.onVoiceState({ guild: f.ctx.guild }, { id: 'new', channelId: null }); assert.equal(original.destroyed, true);
  f.voice.leave();
});

test('failed first greeting and new replies fall back to full text without another voice', async () => {
  const f = await fixture({ synthesize: async () => { throw Error('TTS down'); }, askAI: async () => 'Explicación completa sin recortar.' });
  assert.ok(f.replies.some(r => r.content === 'Escuchando a todo el canal'));
  f.input.get('alice').write(pcm()); await f.advance(240);
  assert.ok(f.replies.some(r => r.content === 'Explicación completa sin recortar.'));
  assert.equal(f.requests.length, 1); f.voice.leave();
});

test('noise and speech under half a second never reach STT', async () => {
  const f = await fixture();
  f.input.get('alice').write(pcm(0)); f.input.get('bob').write(pcm(1000, 8192));
  await f.advance(500); assert.equal(f.transcribed.length, 0); assert.equal(f.requests.length, 0); f.voice.leave();
});

test('persisted exclusions remain enforced after command removal', async () => {
  const f = await fixture({ excluded: 'alice' });
  f.receiver.speaking.emit('start', 'alice');
  assert.equal(f.input.has('alice'), false);
  assert.deepEqual(f.memory.excluded('guild:voice'), ['alice']);
  f.voice.leave();
});

test('reset cancels live STT before it can restore memory', async () => {
  let release;
  const f = await fixture({ transcribe: () => new Promise(resolve => { release = resolve; }) });
  f.input.get('alice').write(pcm()); await f.advance(240);
  await f.voice.forget('alice'); release('TARS pregunta'); await f.advance(0);
  assert.equal(f.requests.length, 0); f.voice.leave();
});

test('local mute, deafen and manual resume use no LLM and keep command semantics', async () => {
  let text = 'TARS mute';
  const f = await fixture({ transcribe: async () => text });
  f.input.get('alice').write(pcm()); await f.advance(240); assert.equal(f.requests.length, 0);
  text = 'TARS deafen'; f.input.get('alice').write(pcm()); await f.advance(240);
  assert.equal(f.input.get('alice').destroyed, true); assert.equal(f.requests.length, 0);
  await f.voice.handle(f.ctx, 'escuchar'); assert.equal(f.input.get('alice').destroyed, false);
  text = 'una respuesta sin palabra de activación'; f.input.get('alice').write(pcm()); await f.advance(240);
  assert.equal(f.requests.length, 1);
  await f.voice.handle(f.ctx, 'salir'); assert.equal(f.destroyed, true);
});

test('leaving while model streams prevents speech and memory resurrection', async () => {
  let release;
  const f = await fixture({ askAI: async () => { await new Promise(r => { release = r; }); return 'Tarde.'; } });
  f.input.get('alice').write(pcm()); await f.advance(240); f.voice.leave(); release(); await f.advance(0);
  assert.deepEqual(f.said, ['Escuchando a todo el canal']);
  assert.equal(f.memory.snapshot('guild:voice').messages.length, 0);
});

test('unaddressed background contributes channel context without a model call; idle timeout remains', async () => {
  const f = await fixture({ transcribe: async () => 'Me gusta el ajedrez' });
  f.input.get('alice').write(pcm()); await f.advance(240);
  assert.equal(f.requests.length, 0); assert.match(f.memory.snapshot('guild:voice').context, /ajedrez/);
  await f.advance(300000); assert.equal(f.destroyed, true);
});

for (const text of ['TARS salte', 'TARS muchas gracias ya puedes marcharte', 'TARS desconéctate']) {
  test('spoken exit bypasses AI: ' + text, async () => {
    const f = await fixture({ transcribe: async () => text });
    f.input.get('alice').write(pcm()); await f.advance(240);
    assert.equal(f.destroyed, true); assert.equal(f.requests.length, 0);
    assert.equal(f.receiver.speaking.listenerCount('start'), 0);
    assert.equal(f.timers.size, 0); assert.ok([...f.input.values()].every(s => s.destroyed));
    assert.equal(f.logs.filter(x => x.event === 'voz_desconexion').length, 1);
  });
}

test('exit interrupts playback, cancels pending work and ignores another guild', async () => {
  let text = 'TARS explica Marte', playing = false;
  const f = await fixture({ transcribe: async () => text, entersState: async (target, state, signal) => {
    if (state === 'idle' && playing) await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  playing = true;
  f.input.get('alice').write(pcm()); await f.advance(240);
  assert.equal(f.requests.length, 1);
  f.voice.onVoiceState({ guild: { id: 'other' } }, { id: 'bot', channelId: null });
  assert.equal(f.destroyed, false);
  text = 'TARS salte'; f.input.get('bob').write(pcm()); await f.advance(240);
  assert.equal(f.destroyed, true); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].opts.signal.aborted, true);
  assert.equal(f.receiver.speaking.listenerCount('start'), 0);
});

test('exit remains available with eight queued model turns and late answer cannot play', async () => {
  let release, text = 'TARS explica Marte';
  const f = await fixture({ transcribe: async () => text, askAI: () => new Promise(resolve => { release = resolve; }) });
  for (let i = 0; i < 8; i++) { f.input.get('alice').write(pcm()); await f.advance(240); }
  text = 'TARS salte'; f.input.get('bob').write(pcm()); await f.advance(240);
  assert.equal(f.destroyed, true); release('Tarde'); await f.advance(0);
  assert.deepEqual(f.said, ['Escuchando a todo el canal']);
});

test('countdown has fixed deadline despite repeat and audio errors, no model or synthesis', async () => {
  let text = 'TARS autodestrucción', reads = 0;
  const f = await fixture({ transcribe: async () => text, countdown: async () => { reads++; throw Error('audio unavailable'); } });
  f.input.get('alice').write(pcm()); await f.advance(240);
  await f.advance(1000);
  f.input.get('bob').write(pcm()); await f.advance(240);
  f.player.emit('error', Error('decoder failed'));
  await f.advance(3759); assert.equal(f.destroyed, false);
  await f.advance(1); assert.equal(f.destroyed, true);
  assert.equal(reads, 1); assert.equal(f.requests.length, 0);
  assert.deepEqual(f.said, ['Escuchando a todo el canal']);
  assert.equal(f.logs.filter(x => x.event === 'voz_autodestruccion_inicio').length, 1);
  assert.equal(f.logs.filter(x => x.event === 'voz_desconexion').length, 1);
  assert.equal(f.timers.size, 0);
});

test('normal exit interrupts countdown immediately; outsiders and bots cannot issue it', async () => {
  let text = 'TARS autodestrúyete';
  const f = await fixture({ transcribe: async () => text });
  f.receiver.speaking.emit('start', 'outsider'); assert.equal(f.input.has('outsider'), false);
  f.receiver.speaking.emit('start', 'bot'); assert.equal(f.input.has('bot'), false);
  f.input.get('alice').write(pcm()); await f.advance(240);
  assert.equal(f.plays.length, 2);
  text = 'TARS por favor salte'; f.input.get('bob').write(pcm()); await f.advance(240);
  assert.equal(f.destroyed, true); assert.equal(f.timers.size, 0); assert.equal(f.requests.length, 0);
});

test('negation and casual mention never disconnect', async () => {
  for (const text of ['TARS no te desconectes', '¿Por qué TARS se desconectó?', 'TARS no te autodestruyas', 'TARS']) {
    const f = await fixture({ transcribe: async () => text });
    f.input.get('alice').write(pcm()); await f.advance(240);
    assert.equal(f.destroyed, false); f.voice.leave();
  }
});
