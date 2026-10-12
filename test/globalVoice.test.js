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
  const timers = new Set(), input = new Map(), replies = [], said = [], requests = [], transcribed = [];
  const receiver = { speaking: new EventEmitter(), subscribe(id) { if (input.has(id) && !input.get(id).destroyed) return input.get(id); const stream = new PassThrough(); input.set(id, stream); return stream; } };
  const connection = new EventEmitter(); connection.receiver = receiver; connection.subscribe = () => {}; connection.destroy = () => { destroyed = true; }; connection.rejoin = () => true;
  const player = new EventEmitter(); player.play = () => {}; player.stop = () => {};
  const api = { joinVoiceChannel: () => connection, createAudioPlayer: () => player, createAudioResource: () => ({ playStream: new PassThrough(), volume: { setVolume() {} } }),
    entersState: async () => {}, StreamType: { Arbitrary: 0 }, EndBehaviorType: { Manual: 0 }, VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'gone' }, AudioPlayerStatus: { Playing: 'playing', Idle: 'idle' } };
  const members = new Map([['alice', { displayName: 'Alicia', user: { bot: false } }], ['bob', { displayName: 'Roberto', user: { bot: false } }], ['bot', { user: { bot: true } }]]);
  const channel = { id: 'voice', type: 2, members, permissionsFor: () => ({ has: () => true }) };
  const guild = { id: 'guild', members: { me: {}, fetch: async () => ({ voice: { channel } }) } }; channel.guild = guild;
  const ctx = { guild, user: { id: 'alice' }, channel: { send: async payload => replies.push(payload) }, reply: async text => replies.push({ content: text }) };
  const memory = createContextManager({ persist: false });
  const voice = createVoice({ enabled: true, env: {}, client: { user: { id: 'bot' } }, api, memory,
    decoderFactory: () => new PassThrough(), vadFactory: () => ({ frameBytes: 1024, process: b => b.readInt16LE(0) !== 0, reset() {}, close() {} }),
    audio: { check: async () => {}, synthesize: async text => { said.push(text); if (options.synthesize) return options.synthesize(text); return Buffer.from('wav'); }, close() {}, transcribe: async (b, signal) => {
      transcribed.push(b); if (options.transcribe) return options.transcribe(b, signal);
      return b.readInt16LE(0) === 1000 ? 'TARS, ¿cómo funciona la gravedad?' : 'TARS, ¿qué es Marte?';
    } },
    askAI: async (id, text, opts) => { requests.push({ id, text, opts }); if (options.askAI) return options.askAI(id, text, opts); return 'Respuesta breve.'; },
    now: () => time, setTimer: (fn, delay) => { const timer = { fn, deadline: time + delay }; timers.add(timer); return timer; }, clearTimer: timer => timers.delete(timer) });
  async function advance(ms) { time += ms; for (const t of [...timers]) if (t.deadline <= time) { timers.delete(t); t.fn(); } for (let i = 0; i < 8; i++) await tick(); }
  await voice.handle(ctx, 'entrar');
  return { voice, ctx, input, members, memory, requests, transcribed, said, replies, receiver, advance, get destroyed() { return destroyed; } };
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

test('privacy cancels live STT and exclusion prevents resubscription', async () => {
  let resolve;
  const f = await fixture({ transcribe: () => new Promise(r => { resolve = r; }) });
  f.input.get('alice').write(pcm()); await f.advance(240);
  await f.voice.handle(f.ctx, 'privacidad', 'excluir');
  resolve('TARS qué hora es'); await f.advance(0);
  assert.equal(f.requests.length, 0); assert.equal(f.input.get('alice').destroyed, true);
  f.receiver.speaking.emit('start', 'alice'); assert.equal(f.input.get('alice').destroyed, true);
  assert.deepEqual(f.memory.excluded('guild:voice'), ['alice']);
  await f.voice.handle(f.ctx, 'privacidad', 'incluir'); assert.equal(f.input.get('alice').destroyed, false);
  f.voice.leave();
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
