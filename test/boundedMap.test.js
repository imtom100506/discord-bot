const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BoundedMap } = require("../src/boundedMap");
const { appendContext } = require("../src/commandUtils");

test("bounded cache evicts the least recently used entry and handles updates", () => {
  const cache = new BoundedMap(2);
  cache.set("a", 1).set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);
  assert.equal(cache.has("b"), false);
  cache.set("a", 4);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("a"), 4);
  cache.delete("a");
  assert.equal(cache.get("a"), undefined);
  assert.throws(() => new BoundedMap(0), RangeError);
});

test("channel context retains recent messages within count and character limits", () => {
  const history = [];
  for (let i = 0; i < 100; i++) appendContext(history, `mensaje ${i}`);
  assert.equal(history.length, 50);
  assert.equal(history.at(-1), "mensaje 99");
  appendContext(history, "x".repeat(10000));
  assert.equal(history.join("\n").length, 4000);
  appendContext(history, "último mensaje");
  assert.deepEqual(history, ["último mensaje"]);
});
