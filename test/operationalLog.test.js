const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOperationalLog } = require('../src/operationalLog');
function fixture({ env = {}, send, cached = true, permitted = true } = {}) {
  const sent = [], warnings = [], waits = []; let fetches = 0;
  const channel = { id: 'log', name: 'logs-tars', isTextBased: () => true,
    permissionsFor: () => ({ has: () => permitted }), send: async payload => { if (send) await send(); sent.push(payload); } };
  const guild = { id: 'g', members: { me: {} }, channels: { cache: new Map(cached ? [['log', channel]] : []), fetch: async () => { fetches++; return new Map([['log', channel]]); } } };
  channel.guild = guild;
  const client = { guilds: { cache: new Map([['g', guild]]) }, channels: { cache: new Map(cached ? [['log', channel]] : []), fetch: async id => { fetches++; assert.equal(id, 'log'); return channel; } } };
  const log = createOperationalLog(client, { env, intervalMs: 0, maxPending: 3, sleep: async ms => waits.push(ms), diagnostic: text => warnings.push(text) });
  return { log, sent, warnings, waits, get fetches() { return fetches; } };
}
test('missing ID falls back to existing channel using fetch, with contextual redacted records', async () => {
  const f = fixture({ cached: false, env: { DISCORD_TOKEN: 'secret-token' } });
  await f.log.withContext({ guild: { id: 'g' }, channel: { id: 'v' }, user: { id: 'u' } }, () => f.log('voz_error', { error: 'secret-token failed', mensaje: 'private transcript' }));
  assert.equal(f.fetches, 1); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].content, /servidor_id: g/); assert.match(f.sent[0].content, /canal_id: v/);
  assert.match(f.sent[0].content, /usuario_id: u/); assert.match(f.sent[0].content, /redactado/);
  assert.doesNotMatch(f.sent[0].content, /secret-token|private transcript/);
  assert.deepEqual(f.sent[0].allowedMentions.parse, []);
});
test('configured ID uses cache; missing permissions diagnoses without sending or retries', async () => {
  const f = fixture({ env: { LOG_CHANNEL_ID: 'log' } }); await f.log('ping');
  assert.equal(f.fetches, 0); assert.equal(f.sent.length, 1);
  const denied = fixture({ permitted: false }); assert.equal(await denied.log('ping'), false);
  assert.equal(denied.sent.length, 0); assert.match(denied.warnings[0], /permisos efectivos/);
});
test('transient failures retry at most twice; permanent failures do not loop', async () => {
  let calls = 0;
  const f = fixture({ send: () => { if (++calls < 3) throw Object.assign(Error('unavailable'), { status: 503 }); } });
  assert.equal(await f.log('evento'), true); assert.equal(calls, 3); assert.equal(f.sent.length, 1);
  let failures = 0;
  const down = fixture({ send: () => { failures++; throw Object.assign(Error('limited'), { status: 429, retry_after: 2 }); } });
  assert.equal(await down.log('evento'), false); assert.equal(failures, 3); assert.equal(down.warnings.length, 1);
  assert.ok(down.waits.includes(2000));
  const permanent = fixture({ send: () => { throw Object.assign(Error('denied'), { status: 403 }); } });
  assert.equal(await permanent.log('evento'), false); assert.equal(permanent.warnings.length, 1);
});
test('bursts are bounded, serial and do not duplicate successful records', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ send: () => gate });
  const jobs = Array.from({ length: 10 }, (_, i) => f.log(`event_${i}`));
  release(); const results = await Promise.all(jobs);
  assert.equal(results.filter(Boolean).length, 3); assert.equal(f.sent.length, 3);
  assert.equal(f.warnings.length, 1);
});
