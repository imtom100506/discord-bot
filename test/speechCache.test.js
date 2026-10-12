const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSpeechCache, validWav } = require('../src/speechCache');
const { wav, createVoiceAudio } = require('../src/voiceAudio');
const { speechParts, profileId } = require('../src/voiceProfile');
const signal = () => new AbortController().signal;
test('cache enforces byte and entry limits and invalidates profile changes', async () => {
  const a = createSpeechCache({ identity: 'voice1', maxBytes: 250, maxEntries: 2 });
  const b = createSpeechCache({ identity: 'voice2' });
  assert.notEqual(a.key('Hola'), b.key('Hola'));
  const bytes = wav(Buffer.alloc(56));
  a.put('a', bytes); a.put('b', bytes); await a.get('a'); a.put('c', bytes);
  assert.equal(await a.get('b'), undefined); assert.deepEqual(await a.get('a'), bytes);
  assert.deepEqual(a.stats(), { bytes: 200, entries: 2 });
  a.put('large', wav(Buffer.alloc(400))); assert.equal(a.stats().bytes, 200);
  assert.throws(() => a.put('bad', bytes.subarray(0, 50))); assert.equal(validWav(Buffer.from('bad')), false);
});
test('pregenerated first greeting uses fixed profile without loading model', async () => {
  const audio = createVoiceAudio({ neural: { warm() { throw Error('Unexpected model load'); } } });
  const bytes = await audio.synthesize('Escuchando a todo el canal', signal());
  assert.equal(validWav(bytes), true);
  const cache = createSpeechCache({ identity: profileId });
  assert.deepEqual(bytes, await cache.get('Escuchando a todo el canal'));
});
test('concurrent duplicates synthesize once; different replies never overlap', async () => {
  let calls = 0, active = 0, peak = 0;
  const audio = createVoiceAudio({ neural: { warm() {}, close() {}, async synthesize() {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--; return wav(Buffer.alloc(100));
  } } });
  const bytes = await Promise.all(['Unique one', 'Unique one', 'Unique two'].map(t => audio.synthesize(t, signal())));
  assert.equal(calls, 2); assert.equal(peak, 1); assert.deepEqual(bytes[0], bytes[1]); audio.close();
});
test('invalid generation is retried with same engine and never cached', async () => {
  let calls = 0;
  const audio = createVoiceAudio({ neural: { warm() {}, close() {}, synthesize: async () => { calls++; return Buffer.from('broken'); } } });
  await assert.rejects(audio.synthesize('Unique corrupt', signal()), /WAV/); assert.equal(calls, 2);
});

test('transient failure recovers with the same voice and caches only successful WAV', async () => {
  let calls = 0, loads = 0;
  const audio = createVoiceAudio({ neural: { warm() { loads++; }, close() {}, synthesize: async () => {
    if (++calls === 1) throw Error('temporary'); return wav(Buffer.alloc(100));
  } } });
  const first = await audio.synthesize('Recover unique', signal());
  assert.equal(calls, 2); assert.equal(loads, 2);
  assert.deepEqual(first, await audio.synthesize('Recover unique', signal()));
  assert.equal(calls, 2);
});

test('paid-credit STT and alternate voice engines are rejected before any process', async () => {
  for (const env of [{ TARS_STT_PROVIDER: 'deepgram' }, { TARS_TTS_ENGINE: 'espeak' }]) {
    const audio = createVoiceAudio({ env, runImpl: () => assert.fail('Unexpected process') });
    await assert.rejects(audio.check(), /gratuito|voz fija/);
  }
});
test('splitting keeps final words and language without truncation', () => {
  const text = 'Esta explicación necesita varios fragmentos. '.repeat(30) + 'Final intacto. Hello!';
  const parts = speechParts(text);
  assert.ok(parts.length > 1); assert.ok(parts.every(t => t.length <= 240));
  assert.equal(parts.join(' '), text.trim());
});
test('synthesis queue is bounded and old session jobs cannot play', async () => {
  let release;
  const audio = createVoiceAudio({ neural: { warm: () => new Promise(r => { release = r; }), close() {}, synthesize: async () => wav(Buffer.alloc(100)) } });
  const jobs = Array.from({ length: 8 }, (_, i) => audio.synthesize('Queue ' + i, signal()));
  const settled = Promise.allSettled(jobs);
  await assert.rejects(audio.synthesize('Overflow', signal()), /Cola/);
  await new Promise(resolve => setTimeout(resolve, 20)); audio.close(); release();
  assert.ok((await settled).every(r => r.status === 'rejected'));
});
