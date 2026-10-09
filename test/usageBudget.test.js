const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createUsageBudget } = require('../src/usageBudget');

test('six voice turns fit per minute; limits persist and expire without clearing history', async () => {
  let time = 1000, saved;
  const store = { read: async () => saved, write: async s => { saved = s; } };
  const budget = createUsageBudget({ store, now: () => time });
  for (let i = 0; i < 6; i++) {
    await budget.reserve({ audio: 10 }); await budget.reserve({ tokens: 1000 });
  }
  const restarted = createUsageBudget({ store, now: () => time });
  await assert.rejects(restarted.reserve({ audio: 10 }), { code: 'AI_BUDGET', reason: 'requests_minute', retryAfterMs: 60000 });
  time += 60000;
  await restarted.reserve({ audio: 10 });
  assert.equal(JSON.parse(saved).length, 13);
});

test('daily exhaustion has a distinct message and exact recovery time', async () => {
  let time = 0, saved;
  const budget = createUsageBudget({ dailyRequests: 2, now: () => time,
    store: { read: async () => saved, write: async s => { saved = s; } } });
  await budget.reserve(); time = 1000; await budget.reserve();
  await assert.rejects(budget.reserve(), e => e.reason === 'requests_day' && e.retryAfterMs === 86399000 && !e.message.includes('presupuesto'));
  time = 86400000; await budget.reserve();
});

test('failed writes and invalid reservations never create usage entries', async () => {
  let writes = 0;
  const budget = createUsageBudget({ store: { read: async () => null, write: async () => { writes++; throw Error(); } } });
  await assert.rejects(budget.reserve({ audio: -1 }), { reason: 'storage' });
  assert.equal(writes, 0);
  await assert.rejects(budget.reserve(), { reason: 'storage' });
  assert.equal(writes, 1);
});

test('actual tokens replace estimates durably without resetting request or audio counts', async () => {
  let saved;
  const store = { read: async () => saved, write: async s => { saved = s; } };
  const budget = createUsageBudget({ store, now: () => 1000, dailyTokens: 1000 });
  const receipt = await budget.reserve({ tokens: 900 });
  await assert.rejects(budget.reserve({ tokens: 200 }), { reason: 'tokens_day' });
  await Promise.all([receipt.settle(100), budget.reserve({ audio: 10 })]);
  await receipt.settle(1);
  const restarted = createUsageBudget({ store, now: () => 1000, dailyTokens: 1000 });
  await restarted.reserve({ tokens: 900 });
  assert.deepEqual(JSON.parse(saved).map(e => [e.tokens, e.audio]), [[100, 0], [0, 10], [900, 0]]);
});

test('missing usage and failed settlement keep the conservative reservation', async () => {
  let saved, fail = false;
  const budget = createUsageBudget({ store: { read: async () => saved, write: async s => { if (fail) throw Error(); saved = s; } } });
  const receipt = await budget.reserve({ tokens: 900 });
  for (const usage of [undefined, NaN, -1, 0, 1.5]) await receipt.settle(usage);
  assert.equal(JSON.parse(saved)[0].tokens, 900);
  fail = true; await receipt.settle(100);
  assert.equal(JSON.parse(saved)[0].tokens, 900);
});

test('balance reflects reservations, actual usage and rolling expiry; unknown is not zero', async () => {
  let time = 0;
  const budget = createUsageBudget({ now: () => time, dailyTokens: 1000, store: { read: async () => null, write: async () => {} } });
  assert.equal(budget.status().tokens_restantes, null);
  const receipt = await budget.reserve({ tokens: 800 });
  assert.equal(budget.status().tokens_restantes, 200);
  await receipt.settle(100);
  assert.equal(budget.status().tokens_restantes, 900);
  time = 86400000;
  assert.equal(budget.status().tokens_restantes, 1000);
});
