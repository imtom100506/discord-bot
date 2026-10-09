const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ChannelType, PermissionsBitField, PermissionFlagsBits: P } = require("discord.js");
const { createTextMutes, TEXT_PERMISSIONS } = require("../src/textMute");

function fixture() {
  const files = new Map(), channels = new Map(), edits = [];
  let time = 1000;
  const storage = {
    async readFile(file) { if (!files.has(file)) throw { code: "ENOENT" }; return files.get(file); },
    async mkdir() {}, async writeFile(file, data) { files.set(file, data); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
  const guild = { id: "g", members: { fetchMe: async () => ({}) }, channels: {
    async fetch(id) { return id ? channels.get(id) ?? null : channels; },
  } };
  function addChannel(id, type = ChannelType.GuildText, before = null) {
    const cache = new Map();
    if (before) cache.set("u", { allow: new PermissionsBitField(before.allow), deny: new PermissionsBitField(before.deny) });
    const channel = { id, type, guild, isThread: () => type === ChannelType.PublicThread,
      isTextBased: () => [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.PublicThread].includes(type),
      permissionsFor: () => ({ has: () => !channel.noPermission }), permissionOverwrites: {
        cache,
        async edit(userId, changes) {
          if (channel.fail) { channel.fail--; throw { code: 50013 }; }
          edits.push({ id, changes });
          const current = cache.get(userId) || { allow: new PermissionsBitField(), deny: new PermissionsBitField() };
          for (const [name, value] of Object.entries(changes)) {
            current.allow.remove(P[name]); current.deny.remove(P[name]);
            if (value === true) current.allow.add(P[name]);
            if (value === false) current.deny.add(P[name]);
          }
          cache.set(userId, current);
        },
        async delete(userId) { cache.delete(userId); },
      },
    };
    channels.set(id, channel);
    return channel;
  }
  return { guild, edits, storage, addChannel, channels, files, advance: ms => { time += ms; },
    client: { guilds: { fetch: async () => guild } },
    service: () => createTextMutes({ file: "state.json", storage, now: () => time }) };
}

test("mute blocks text, forum posts and threads without altering voice or existing permissions", async () => {
  const f = fixture();
  const before = { allow: [P.SendMessages, P.Speak, P.Connect], deny: [P.AttachFiles] };
  const text = f.addChannel("text", ChannelType.GuildText, before);
  const voice = f.addChannel("voice", ChannelType.GuildVoice, before);
  const forum = f.addChannel("forum", ChannelType.GuildForum);
  f.addChannel("category", ChannelType.GuildCategory);
  f.addChannel("thread", ChannelType.PublicThread);
  const service = f.service();
  await service.mute(f.guild, "u", 10000, "test");
  assert.deepEqual(f.edits.map(edit => edit.id), ["text", "voice", "forum"]);
  assert.ok(f.edits.every(edit => Object.keys(edit.changes).every(name => TEXT_PERMISSIONS.includes(name))));
  for (const channel of [text, voice]) {
    const overwrite = channel.permissionOverwrites.cache.get("u");
    assert.ok(overwrite.allow.has(P.Speak | P.Connect));
    assert.ok(overwrite.deny.has(P.SendMessages | P.SendMessagesInThreads | P.AttachFiles));
  }
  assert.equal(await service.unmute(f.guild, "u", "test"), true);
  for (const channel of [text, voice]) {
    const overwrite = channel.permissionOverwrites.cache.get("u");
    assert.equal(overwrite.allow.bitfield, new PermissionsBitField(before.allow).bitfield);
    assert.equal(overwrite.deny.bitfield, new PermissionsBitField(before.deny).bitfield);
  }
  assert.equal(forum.permissionOverwrites.cache.size, 0);
  assert.equal(await service.unmute(f.guild, "u", "test"), false);
});

test("expiry survives restart, extension preserves originals, new channels are covered", async () => {
  const f = fixture();
  const channel = f.addChannel("text");
  await f.service().mute(f.guild, "u", 10000, "test");
  const restarted = f.service();
  f.advance(5000);
  await restarted.mute(f.guild, "u", 20000, "extend");
  const created = f.addChannel("new");
  await restarted.syncChannel(created);
  assert.ok(created.permissionOverwrites.cache.get("u").deny.has(P.SendMessages));
  const offlineCreated = f.addChannel("offline");
  await restarted.syncGuild(f.guild);
  assert.ok(offlineCreated.permissionOverwrites.cache.get("u").deny.has(P.SendMessages));
  f.advance(6000);
  await restarted.sweep(f.client);
  assert.equal(channel.permissionOverwrites.cache.size, 1);
  f.advance(15000);
  await f.service().sweep(f.client);
  for (const item of f.channels.values()) assert.equal(item.permissionOverwrites.cache.size, 0);
});

test("permission failures change nothing; partial failures roll back and restoration retries", async () => {
  const f = fixture();
  const a = f.addChannel("a"), b = f.addChannel("b");
  b.noPermission = true;
  await assert.rejects(f.service().mute(f.guild, "u", 10000, "test"));
  assert.equal(f.edits.length, 0);
  b.noPermission = false; b.fail = 1;
  await assert.rejects(f.service().mute(f.guild, "u", 10000, "test"));
  assert.equal(a.permissionOverwrites.cache.size, 0);
  const service = f.service();
  await service.mute(f.guild, "u", 1000, "test");
  a.fail = 1;
  f.advance(2000);
  await service.sweep(f.client);
  assert.equal(a.permissionOverwrites.cache.size, 1);
  await f.service().sweep(f.client);
  assert.equal(a.permissionOverwrites.cache.size, 0);
  assert.equal(b.permissionOverwrites.cache.size, 0);
});

test("restore preserves unrelated changes and explicitly changed text permissions", async () => {
  const f = fixture();
  const channel = f.addChannel("text");
  const service = f.service();
  await service.mute(f.guild, "u", 1000, "test");
  await channel.permissionOverwrites.edit("u", { Speak: false, SendMessages: true });
  await service.unmute(f.guild, "u", "test");
  const overwrite = channel.permissionOverwrites.cache.get("u");
  assert.ok(overwrite.allow.has(P.SendMessages));
  assert.ok(overwrite.deny.has(P.Speak));
  assert.equal(overwrite.deny.has(P.SendMessagesInThreads), false);
});

test("unwritable storage or corrupt state prevents Discord mutations", async () => {
  const f = fixture();
  f.addChannel("text");
  f.files.set("state.json", "invalid");
  await assert.rejects(f.service().mute(f.guild, "u", 1000, "test"));
  f.files.delete("state.json");
  f.storage.writeFile = async () => { throw new Error("Disk full"); };
  await assert.rejects(f.service().mute(f.guild, "u", 1000, "test"));
  assert.equal(f.edits.length, 0);
});

test("mute journals all channels in one write and avoids redundant permission updates", async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) f.addChannel(String(i));
  let writes = 0;
  const write = f.storage.writeFile;
  f.storage.writeFile = async (...args) => { writes++; return write(...args); };
  const service = f.service();
  await service.mute(f.guild, "u", 10000, "test");
  assert.equal(writes, 1);
  assert.equal(f.edits.length, 10);
  const saved = JSON.parse(f.files.get("state.json"));
  assert.equal(saved.records[0].channels.length, 10);
  await service.syncGuild(f.guild);
  await service.mute(f.guild, "u", 20000, "extend");
  assert.equal(f.edits.length, 10);
  assert.equal(writes, 2);
});