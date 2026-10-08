const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDiscordMuteStore, MARKER } = require("../src/muteStore");

test("Discord state survives process restart and ignores other authors' fake records", async () => {
  const messages = new Map([["fake", { id: "fake", author: { id: "someone" }, content: MARKER }]]);
  let body, sends = 0, edits = 0;
  const channel = { isTextBased: () => true, messages: { fetch: async () => messages },
    async send(payload) {
      sends++;
      body = payload.files[0].attachment.toString("utf8");
      const message = { id: "real", author: { id: "bot" }, content: payload.content,
        attachments: new Map([["file", { name: "tars-text-mutes.json", url: "https://example.test/state" }]]),
        async edit(next) { edits++; body = next.files[0].attachment.toString("utf8"); return this; },
      };
      messages.set("real", message);
      return message;
    },
  };
  const client = { user: { id: "bot" }, channels: { fetch: async () => channel } };
  const download = async () => ({ ok: true, text: async () => body });
  const store = createDiscordMuteStore(client, "logs", download);
  assert.equal(await store.read(), null);
  await store.write('{"version":1,"records":[]}');
  await store.write('{"version":1,"records":[{"userId":"u"}]}');
  await store.write('{"version":1,"records":[{"userId":"u"}]}');
  const restarted = createDiscordMuteStore(client, "logs", download);
  assert.equal(await restarted.read(), body);
  await restarted.write('{"version":1,"records":[]}');
  assert.equal(sends, 1);
  assert.equal(edits, 2);
  const failing = createDiscordMuteStore(client, "logs", async () => ({ ok: false }));
  await assert.rejects(failing.read());
});
