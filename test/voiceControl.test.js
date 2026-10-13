const { test } = require('node:test');
const assert = require('node:assert/strict');
const { voiceControl } = require('../src/voiceControl');
for (const text of ['TARS, salte del canal de voz', 'TARS, salte', 'TARS, muchas gracias, ya puedes marcharte',
  'TARS, por favor, salte', 'TARS, desconéctate', 'TARS, puedes irte', 'TARS, retírate', 'TARS, déjanos solos',
  '¡Hey TARS! sal del canal, por favor.']) {
  test(`local leave: ${text}`, () => assert.equal(voiceControl(text), 'leave'));
}
for (const text of ['TARS, autodestrucción', 'TARS, autodestrúyete', 'TARS, activa la autodestrucción',
  'TARS, por favor, inicia la autodestrucción']) {
  test(`local countdown: ${text}`, () => assert.equal(voiceControl(text), 'countdown'));
}
for (const text of ['TARS, no te vayas', 'TARS, no te desconectes', '¿Por qué TARS se desconectó?', 'TARS',
  'TARS, no te autodestruyas', 'TARS, ¿qué hace la autodestrucción?', 'salte', 'TARS dijo desconéctate',
  'TARS, si te digo salte, ¿qué haces?', 'TARS, no actives la autodestrucción', 'ayer TARS salte', 'TARS puedes irte pero no ahora']) {
  test(`no action: ${text}`, () => assert.equal(voiceControl(text), null));
}
test('packaged countdown is five seconds, contains five audible slots and never synthesizes', async () => {
  const audio = require('../src/voiceAudio').createVoiceAudio({ neural: { synthesize() { throw Error('must not synthesize'); } } });
  const bytes = await audio.countdown();
  assert.ok(require('../src/speechCache').validWav(bytes));
  const rate = bytes.readUInt32LE(24);
  assert.equal(bytes.length - 44, rate * 2 * 5);
  for (let i = 0; i < 5; i++) assert.ok(bytes.subarray(44 + i * rate * 2, 44 + (i + 1) * rate * 2).some(x => x !== 0));
  assert.deepEqual(await audio.countdown(), bytes);
});
