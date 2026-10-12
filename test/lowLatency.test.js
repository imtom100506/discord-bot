const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createLowLatencyPipeline, classify } = require('../src/optimization/lowLatencyPipeline.ts');
const { createContextManager } = require('../src/optimization/contextManager');
const signal = () => new AbortController().signal;

test('local classifier executes controls and tools without model calls, never acts on partials', async () => {
  const commands = [], tools = [];
  const memory = createContextManager({ persist: false });
  const p = createLowLatencyPipeline({ memory, askAI: () => { throw Error('unexpected model'); },
    execute: async intent => { commands.push(intent); return 'Listo'; },
    tools: { search_web: async x => { tools.push(x.query); return 'Resultado'; }, generate_image: async x => { tools.push(x.prompt); return 'Imagen'; } } });
  p.prepare('c', 'u', 'TARS mute'); assert.equal(commands.length, 0);
  for (const text of ['mute', 'deafen', 'deja de escuchar', 'repite', 'sube volumen', 'baja el volumen', 'ayuda', 'mutea a Roberto']) await p.run({ key: 'c', userId: 'u', text: `TARS ${text}`, signal: signal() });
  assert.deepEqual(commands, ['mute', 'stop', 'stop', 'repeat', 'volume_up', 'volume_down', 'help', 'moderation_help']);
  await p.run({ key: 'c', userId: 'u', text: 'TARS busca en internet Saturno', signal: signal() });
  await p.run({ key: 'c', userId: 'u', text: 'TARS genera una imagen de Saturno', signal: signal() });
  assert.deepEqual(tools, ['saturno', 'saturno']);
  assert.equal(classify('¿Puedes explicar la gravedad?').direct, true);
  assert.notEqual(classify('no te mutees').kind, 'command');
});

test('wake filter, frequent cache, humor and disabled tools are local; latest final overrides partial', async () => {
  let calls = 0, opts;
  const memory = createContextManager({ persist: false });
  const p = createLowLatencyPipeline({ memory, execute: () => { throw Error('unexpected command'); }, askAI: async (id, text, options) => { calls++; opts = options; return 'Respuesta'; } });
  const run = text => p.run({ key: 'g:c', userId: 'u', text, signal: signal() });
  assert.equal((await run('hablemos entre nosotros')).ignored, true);
  await run('TARS hola'); await run('TARS hola'); await run('TARS humor 42'); await run('TARS busca planetas'); assert.equal(calls, 0);
  p.prepare('g:c', 'u', 'TARS mute'); await run('TARS ¿por qué brilla el sol?');
  assert.equal(calls, 1); assert.match(opts.voicePrompt, /42%/);
});

test('channel context is isolated, summarizes every twenty messages and sends at most six recent', async () => {
  const memory = createContextManager({ persist: false });
  for (let i = 0; i < 20; i++) memory.add('g:c', { userId: 'u', name: 'A', role: 'user', text: `tema ${i}` });
  const snapshot = memory.snapshot('g:c');
  assert.equal(snapshot.messages.length, 6); assert.match(JSON.parse(snapshot.context).summary, /tema 19/);
  assert.equal(memory.snapshot('g:other').messages.length, 0);
  await memory.forget('g:c', 'u'); assert.equal(memory.snapshot('g:c').messages.length, 0); assert.equal(JSON.parse(memory.snapshot('g:c').context).summary, '');
});

test('atomic disk memory keeps explicit preferences and exclusions across restart without raw transcript', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tars-memory-'));
  const file = path.join(directory, 'channelMemory.json');
  try {
    const memory = createContextManager({ file }); await memory.load();
    memory.add('g:c', { userId: 'u', name: 'Ana', role: 'user', text: 'Me gusta el ajedrez' });
    memory.add('g:c', { userId: 'u', name: 'Ana', role: 'user', text: 'frase temporal privada' });
    await memory.exclude('g:c', 'u', true);
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /frase temporal privada/);
    const fresh = createContextManager({ file }); await fresh.load();
    assert.match(fresh.snapshot('g:c').context, /ajedrez/); assert.deepEqual(fresh.excluded('g:c'), ['u']);
    assert.equal(fresh.snapshot('g:c').messages.length, 0);
    await fresh.forgetEverywhere('u'); assert.doesNotMatch(fresh.snapshot('g:c').context, /ajedrez/);
    assert.deepEqual(fresh.excluded('g:c'), ['u']);
  } finally { await fs.unlink(file).catch(() => {}); await fs.unlink(file + '.tmp').catch(() => {}); await fs.rmdir(directory).catch(() => {}); }
});

test('memory capacity never evicts persisted privacy exclusions', async () => {
  const memory = createContextManager({ persist: false });
  for (let i = 0; i < 100; i++) await memory.exclude(`g:${i}`, 'u', true);
  assert.throws(() => memory.snapshot('g:new'), /Capacidad/);
  assert.deepEqual(memory.excluded('g:0'), ['u']);
  await memory.exclude('g:1', 'u', false);
  memory.snapshot('g:new');
  assert.deepEqual(memory.excluded('g:0'), ['u']);
});
