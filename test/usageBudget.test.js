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
