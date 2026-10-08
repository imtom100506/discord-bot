const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits: P } = require("discord.js");
const { parseDuration, parseModeration, moderate } = require("../src/moderation");

function fixture(options = {}) {
  const calls = [], replies = [], logs = [], fetches = [];
  const actor = {
    roles: { cache: { some: predicate => options.role !== false && predicate({ name: "Sigma" }) },
      highest: { comparePositionTo: () => options.position ?? 1 } },
    permissions: { has: permission => options.actorPermission !== false && [P.ManageNicknames, P.ModerateMembers].includes(permission) },
  };
  const target = {
    id: options.targetId ?? "123", user: { bot: options.bot ?? false },
    roles: { highest: {} }, manageable: options.manageable ?? true, moderatable: options.moderatable ?? true,
    async timeout(value, reason) { if (options.failure) throw { code: options.failure }; calls.push(["timeout", value, reason]); },
    async setNickname(value, reason) { if (options.failure) throw { code: options.failure }; calls.push(["nickname", value, reason]); },
  };
  const ctx = {
    user: { id: "1", username: "tester" }, reply: async text => replies.push(text),
    guild: { ownerId: options.ownerId ?? "owner", members: {
      async fetch(request) {
        fetches.push(request);
        if (request.user === "1") return actor;
        if (options.missing) throw { code: 10007 };
        return target;
      },
      async fetchMe() { return { permissions: { has: () => options.botPermission !== false } }; },
    } },
  };
  return { ctx, calls, replies, logs, fetches, run: text => moderate(ctx, parseModeration(text), async (...args) => logs.push(args)) };
}

test("timeout durations accept explicit units and enforce Discord's 28 day maximum", () => {
  for (const [input, result] of [["10 minutos", 600000], ["24 horas", 86400000], ["28 días", 2419200000], ["30m", 1800000], ["1s", 1000]]) {
    assert.equal(parseDuration(input), result);
  }
  for (const input of ["0m", "-10m", "1.5h", "10", "29 días", "1h y 30m", "10 minutos y banea a todos", "999999999999999999h"]) {
    assert.equal(parseDuration(input), null);
  }
});

test("parser requires an explicit command, one mention and complete arguments", () => {
  for (const text of ["no mutea a <@123> por 10m", "¿Puedes mutear?", "qué hace mutea a <@123> por 10m", "`mute <@123> 10m`"]) {
    assert.equal(parseModeration(text), null);
  }
  for (const text of ["mutea a tom por 10m", "mutea a <@&123> por 10m", "mutea a <@123> y <@456> por 10m", "mutea a <@123>", "cambia el apodo de <@123>", "apodo <@123> " + "x".repeat(33), 'apodo <@123> ""', 'apodo <@123> "a\nb"']) {
    assert.ok(parseModeration(text).error, text);
  }
  assert.equal(parseModeration("MUTEA a <@!123> por 24 horas").duration, 86400000);
  assert.equal(parseModeration('cambia el apodo de <@123> a "Capitán Tom"').nickname, "Capitán Tom");
  assert.equal(parseModeration("quita el apodo de <@123>").nickname, null);
});

test("timeout, removal and nickname actions call Discord exactly once with audit reason", async () => {
  for (const [text, method, value] of [
    ["mutea a <@123> por 10 minutos", "timeout", 600000],
    ["mute <@123> 24h", "timeout", 86400000],
    ["desmutea a <@123>", "timeout", null],
    ["cambia el apodo de <@123> a Capitán Tom", "nickname", "Capitán Tom"],
    ["quita el apodo de <@123>", "nickname", null],
  ]) {
    const f = fixture();
    await f.run(text);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].slice(0, 2), [method, value]);
    assert.match(f.calls[0][2], /tester \(1\)/);
    assert.equal(f.logs[0][0], "moderacion");
    assert.ok(f.fetches.every(request => request.force));
    assert.equal(f.replies.length, 1);
  }
});

test("roles, permissions, actor and bot hierarchy prevent unauthorized mutations", async () => {
  for (const options of [{ role: false }, { actorPermission: false }, { botPermission: false },
    { position: 0 }, { position: -1 }, { manageable: false }, { targetId: "1" }, { targetId: "owner" }]) {
    for (const text of ["mute <@123> 10m", "desmutea <@123>", "apodo <@123> Nuevo"]) {
      const f = fixture(options);
      await f.run(text);
      assert.equal(f.calls.length, 0);
      assert.equal(f.logs[0][0], "moderacion_denegada");
    }
  }
  for (const options of [{ bot: true }, { moderatable: false }]) {
    const f = fixture(options);
    await f.run("mute <@123> 10m");
    assert.equal(f.calls.length, 0);
  }
  const owner = fixture({ ownerId: "1", position: -1 });
  await owner.run("mute <@123> 10m");
  assert.equal(owner.calls.length, 1);
});

test("DMs, invalid syntax, missing targets and API failures never confirm success", async () => {
  const dm = fixture();
  dm.ctx.guild = null;
  await dm.run("mute <@123> 10m");
  assert.match(dm.replies[0], /servidor/);
  const invalid = fixture();
  await invalid.run("mute <@123> 29 días");
  assert.equal(invalid.fetches.length, 0);
  for (const options of [{ missing: true }, { failure: 50013 }, { failure: 50001 }, { failure: 999 }]) {
    const f = fixture(options);
    await f.run("mute <@123> 10m");
    assert.equal(f.calls.length, 0);
    assert.equal(f.logs[0][0], "moderacion_error");
    assert.doesNotMatch(f.replies[0], /Silenciado|retirado|actualizado/);
  }
});
