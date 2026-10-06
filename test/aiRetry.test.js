const { test } = require("node:test");
const assert = require("node:assert/strict");


const { withAIRetry } = require("../src/aiRetry");

test("503 retries with increasing delays and returns recovered response", async () => {
  let calls = 0;
  const delays = [];
  const result = await withAIRetry(async () => {
    if (++calls < 3) throw Object.assign(new Error("high demand"), { status: 503 });
    return "ok";
  }, { wait: async ms => delays.push(ms), random: () => 0 });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test("persistent overload stops after three requests and preserves cause", async () => {
  let calls = 0;
  const original = Object.assign(new Error("high demand"), { status: 503 });
  await assert.rejects(withAIRetry(async () => { calls++; throw original; }, { wait: async () => {} }),
    error => error.code === "AI_UNAVAILABLE" && error.cause === original);
  assert.equal(calls, 3);
});

test("authentication, model errors and quota errors are not retried", async () => {
  for (const status of [400, 401, 403, 404, 429]) {
    let calls = 0;
    const original = Object.assign(new Error("request failed"), { status });
    await assert.rejects(withAIRetry(async () => { calls++; throw original; }), error => error === original);
    assert.equal(calls, 1);
  }
});


