const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAI, retryAfter } = require('../src/aiClient');
const env = { GROQ_API_KEY: 'test', CLOUDFLARE_API_TOKEN: 'test', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) };
const ok = text => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
const fail = (status, headers = {}) => new Response('{}', { status, headers });
const make = fetchImpl => createAI({ env, systemPrompt: 'TARS', fetchImpl, wait: async () => {}, spacingMs: 0 });

test('503 retries then falls back; only successful turns enter history', async () => {
  const requests = [];
  const ai = make(async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return url.includes('groq.com') ? fail(503) : ok('respuesta');
  });
  assert.equal(await ai.askAI('u', 'hola', { context: 'contexto efímero' }), 'respuesta');
  assert.equal(requests.length, 4);
  await ai.askAI('u', 'otra pregunta');
  const messages = requests.at(-1).body.messages;
  assert.deepEqual(messages.slice(1), [
    { role: 'user', content: 'hola' }, { role: 'assistant', content: 'respuesta' },
    { role: 'user', content: 'otra pregunta' },
  ]);
});

test('429 skips retries and respects Retry-After across later requests', async () => {
  let time = 1000;
  const calls = [];
  const ai = createAI({ env, systemPrompt: '', now: () => time, spacingMs: 0,
    fetchImpl: async url => { calls.push(url); return url.includes('groq.com') ? fail(429, { 'retry-after': '3600' }) : ok('ok'); } });
  await ai.askAI('u', 'a');
  await ai.askAI('u', 'b');
  assert.equal(calls.filter(url => url.includes('groq.com')).length, 1);
  time += 3600001;
  await ai.askAI('u', 'c');
  assert.equal(calls.filter(url => url.includes('groq.com')).length, 2);
  assert.equal(retryAfter(new Date(time + 5000).toUTCString(), time), 4999);
});

test('invalid key falls back without retry; total failure is friendly', async () => {
  let calls = 0;
  const ai = make(async () => { calls++; return fail(401); });
  await assert.rejects(ai.askAI('u', 'hola'), { code: 'AI_UNAVAILABLE' });
  assert.equal(calls, 2);
});

test('missing credentials and overflow do not invoke providers', async () => {
  const ai = createAI({ env: {}, systemPrompt: '' });
  await assert.rejects(ai.askAI('u', 'hola'), { code: 'AI_CONFIG' });
  let release;
  const busy = make(() => new Promise(resolve => { release = () => resolve(ok('ok')); }));
  const jobs = Array.from({ length: 8 }, () => busy.askAI('u', 'hola'));
  await assert.rejects(busy.askAI('u', 'extra'), { code: 'AI_BUSY' });
  for (const job of jobs) { release(); await job; await new Promise(resolve => setImmediate(resolve)); }
});

test('serializes concurrent messages and clearHistory discards in-flight memory', async () => {
  let release;
  const payloads = [];
  let calls = 0;
  const ai = make(async (url, init) => {
    payloads.push(JSON.parse(init.body));
    if (++calls === 1) await new Promise(resolve => { release = resolve; });
    return ok('ok');
  });
  const first = ai.askAI('u', 'borrar esto');
  await new Promise(resolve => setImmediate(resolve));
  ai.clearHistory('u');
  release();
  await first;
  await Promise.all([ai.askAI('u', 'segundo'), ai.askAI('u', 'tercero')]);
  assert.equal(payloads[1].messages.length, 2);
  assert.equal(payloads[2].messages[1].content, 'segundo');
});

test('network errors, malformed JSON, empty and truncated output use fallback', async () => {
  for (const mode of ['network', 'json', 'empty', 'length']) {
    const ai = make(async url => {
      if (!url.includes('groq.com')) return ok('respaldo');
      if (mode === 'network') throw new TypeError('fetch failed');
      if (mode === 'json') return new Response('not json');
      if (mode === 'empty') return ok('');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'cortado' }, finish_reason: 'length' }] }));
    });
    assert.equal(await ai.askAI('u', 'hola'), 'respaldo');
  }
});

test('history and input are bounded and failed turns never get saved', async () => {
  const payloads = [];
  const ai = make(async (url, init) => { payloads.push(JSON.parse(init.body)); return ok('r'.repeat(800)); });
  for (let i = 0; i < 8; i++) await ai.askAI('u', 'q'.repeat(800));
  const last = payloads.at(-1).messages.slice(1, -1);
  assert.ok(last.length <= 8);
  assert.ok(last.reduce((sum, msg) => sum + msg.content.length, 0) <= 4000);
  await ai.askAI('u', 'a'.repeat(20000) + 'FINAL');
  assert.ok(payloads.at(-1).messages.at(-1).content.endsWith('FINAL'));
  assert.ok(payloads.at(-1).messages.at(-1).content.length < 6100);
});

test('both providers bound replies and remember only the delivered text', async () => {
  for (const fallback of [false, true]) {
    const payloads = [];
    const ai = make(async (url, init) => {
      payloads.push(JSON.parse(init.body));
      if (fallback && url.includes('groq.com')) return fail(401);
      return ok('Esta es una frase completa. '.repeat(100));
    });
    const short = await ai.askAI('u', 'hola');
    assert.ok(short.length <= 600);
    assert.ok(short.endsWith('.'));
    const detailed = await ai.askAI('u', 'explica paso a paso');
    assert.ok(detailed.length > 600 && detailed.length <= 1500);
    assert.equal(payloads.at(-1).messages[2].content, short);
    assert.match(payloads.at(-1).messages[0].content, /1500 caracteres/);
    assert.ok((await ai.askAI('u', 'gracias')).length <= 600);
    assert.ok((await ai.askAI('u', 'Resume: usuario pide explicar paso a paso', { brief: true })).length <= 600);
  }
});
