const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const keepAlive = require("../src/keepAlive");

test("native HTTP health endpoint supports GET/HEAD and rejects other paths", async t => {
  const server = keepAlive(0);
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(url + "/?health=1");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "TARS activo");
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(url + "/missing")).status, 404);
  assert.equal((await fetch(url, { method: "POST" })).status, 404);
});
