const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createOpusDecoder } = require('../src/opusDecoder');

test('damaged packet does not discard good audio before or after it', async () => {
  let released = 0;
  const stream = createOpusDecoder({ codec: {
    decode: packet => { if (!packet[0]) throw Error('Decode error: Invalid packet'); return packet; },
    delete: () => { released++; },
  } });
  const output = []; stream.on('data', data => output.push(data));
  const closed = once(stream, 'close');
  stream.write(Buffer.from([1])); stream.write(Buffer.from([0])); stream.end(Buffer.from([2]));
  await closed;
  assert.deepEqual(Buffer.concat(output), Buffer.from([1, 2])); assert.equal(released, 1);
});

test('persistent corruption fails with a bounded number of attempts', async () => {
  const stream = createOpusDecoder({ codec: { decode: () => { throw Error('Decode error: Invalid packet'); }, delete() {} } });
  const error = once(stream, 'error');
  for (let i = 0; i < 5; i++) stream.write(Buffer.from([0]));
  assert.match((await error)[0].message, /Invalid packet/);
});

test('real Opus roundtrip returns 16 kHz mono PCM', async () => {
  const Opus = require('opusscript'); const encoder = new Opus(16000, 1, Opus.Application.VOIP);
  const stream = createOpusDecoder(); const chunks = [];
  stream.on('data', chunk => chunks.push(chunk));
  const closed = once(stream, 'close');
  try { stream.end(encoder.encode(Buffer.alloc(640), 320)); await closed; }
  finally { encoder.delete(); stream.destroy(); }
  assert.equal(Buffer.concat(chunks).length, 640);
});
