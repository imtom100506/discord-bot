const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compactResponse, responseLimit } = require('../src/responsePolicy');

test('short text is unchanged and long unpunctuated output is bounded', () => {
  assert.equal(responseLimit('hola'), 600);
  for (const text of ['dame más detalle', 'explica paso a paso', 'explica con detalle']) {
    assert.equal(responseLimit(text), 1500);
  }
  assert.equal(compactResponse('De nada.', 600), 'De nada.');
  for (const text of ['palabra '.repeat(500), '😀'.repeat(500), 'x'.repeat(1000)]) {
    const result = compactResponse(text, 600);
    assert.ok(result.length <= 600);
    assert.ok(result.isWellFormed());
    assert.ok(result.endsWith('…'));
  }
});
