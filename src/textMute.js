const fs = require("node:fs/promises");
const path = require("node:path");
const { ChannelType, PermissionFlagsBits: P } = require("discord.js");

// No tocar Connect, Speak, MuteMembers ni ningún otro permiso de voz.
const TEXT_PERMISSIONS = ["SendMessages", "SendMessagesInThreads", "CreatePublicThreads", "CreatePrivateThreads"];
const denied = Object.fromEntries(TEXT_PERMISSIONS.map(name => [name, false]));
const supportsTextMute = channel => channel && !channel.isThread() &&
  channel.type !== ChannelType.GuildCategory && channel.permissionOverwrites &&
  (channel.isTextBased() || channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia);

function createTextMutes({ file = path.join(process.env.TARS_DATA_DIR || path.join(__dirname, "..", "data"), "text-mutes.json"),
  now = Date.now, storage = fs, store } = {}) {
  let records;
  let queue = Promise.resolve();
  const serial = task => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };
  async function load() {
    if (records) return;
    try {
      const raw = store ? await store.read() : await storage.readFile(file, "utf8");
      const data = raw === null ? { version: 1, records: [] } : JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.records)) throw new Error("Registro de mutes inválido");
      records = data.records;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      records = [];
    }
  }
  async function save() {
    if (store) return store.write(JSON.stringify({ version: 1, records }));
    await storage.mkdir(path.dirname(file), { recursive: true });
    await storage.writeFile(file + ".tmp", JSON.stringify({ version: 1, records }), "utf8");
    await storage.rename(file + ".tmp", file);
  }
  function snapshotChannel(record, channel) {
    if (record.channels.some(item => item.id === channel.id)) return false;
    const overwrite = channel.permissionOverwrites.cache.get(record.userId);
    record.channels.push({ id: channel.id, existed: !!overwrite, permissions: Object.fromEntries(TEXT_PERMISSIONS.map(name =>
      [name, overwrite?.allow.has(P[name]) ? true : overwrite?.deny.has(P[name]) ? false : null])) });
    return true;
  }
  async function restrict(record, channel, me, reason) {
    if (!channel.permissionsFor(me)?.has(P.ManageRoles)) throw Object.assign(new Error("Falta Gestionar permisos en un canal"), { code: 50013 });
    if (snapshotChannel(record, channel)) {
      try { await save(); }
      catch (error) {
        record.channels = record.channels.filter(item => item.id !== channel.id);
        throw error;
      }
    }
    const overwrite = channel.permissionOverwrites.cache.get(record.userId);
    if (TEXT_PERMISSIONS.every(name => overwrite?.deny.has(P[name]))) return;
    await channel.permissionOverwrites.edit(record.userId, denied, { type: 1, reason });
  }
  async function restore(record, guild, reason) {
    record.restoring = true;
    await save();
    for (const snapshot of [...record.channels]) {
      const channel = await guild.channels.fetch(snapshot.id, { force: true }).catch(error => {
        if (error.code === 10003) return null;
        throw error;
      });
      if (channel) {
        const overwrite = channel.permissionOverwrites.cache.get(record.userId);
        if (overwrite) {
          // Restaurar solo bits que todavía tienen el valor impuesto por TARS.
          const permissions = Object.fromEntries(TEXT_PERMISSIONS.filter(name => overwrite.deny.has(P[name]) && snapshot.permissions[name] !== false)
            .map(name => [name, snapshot.permissions[name]]));
          if (Object.keys(permissions).length) await channel.permissionOverwrites.edit(record.userId, permissions, { type: 1, reason });
          if (!snapshot.existed) {
            const refreshed = Object.keys(permissions).length ? await guild.channels.fetch(snapshot.id, { force: true }) : channel;
            const remaining = refreshed?.permissionOverwrites.cache.get(record.userId);
            if (remaining && remaining.allow.bitfield === 0n && remaining.deny.bitfield === 0n) {
              await channel.permissionOverwrites.delete(record.userId, reason);
            }
          }
        }
      }
      record.channels = record.channels.filter(item => item.id !== snapshot.id);
      await save();
    }
    records = records.filter(item => item !== record);
    await save();
  }
  async function mute(guild, userId, duration, reason) {
    return serial(async () => {
      await load();
      let record = records.find(item => item.guildId === guild.id && item.userId === userId);
      if (record?.restoring) throw new Error("Hay una restauración pendiente; intenta de nuevo");
      const channels = [...(await guild.channels.fetch()).values()].filter(supportsTextMute);
      if (!channels.length) throw new Error("No hay canales de texto disponibles");
      const me = await guild.members.fetchMe();
      // Evitar cambios parciales por permisos que ya sabemos que faltan.
      if (channels.some(channel => !channel.permissionsFor(me)?.has(P.ManageRoles))) {
        throw Object.assign(new Error("Faltan permisos en canales"), { code: 50013 });
      }
      if (!record) {
        record = { guildId: guild.id, userId, expiresAt: now() + duration, channels: [], restoring: false };
        records.push(record);
      } else record.expiresAt = now() + duration;
      // Una sola escritura guarda TODOS los originales antes de tocar Discord.
      for (const channel of channels) snapshotChannel(record, channel);
      await save();
      try {
        for (const channel of channels) await restrict(record, channel, me, reason);
      } catch (error) {
        // La siguiente revisión reintenta la restauración si Discord falla aquí.
        record.restoring = true;
        await restore(record, guild, "Revertir mute de texto incompleto").catch(() => {});
        throw error;
      }
    });
  }
  async function unmute(guild, userId, reason) {
    return serial(async () => {
      await load();
      const record = records.find(item => item.guildId === guild.id && item.userId === userId);
      if (!record) return false;
      await restore(record, guild, reason);
      return true;
    });
  }
  async function sweep(client, log = async () => {}) {
    return serial(async () => {
      await load();
      for (const record of [...records]) {
        if (!record.restoring && record.expiresAt > now()) continue;
        try {
          const guild = await client.guilds.fetch(record.guildId);
          await restore(record, guild, "Fin del mute de texto de TARS");
          await log("mute_texto_finalizado", { usuario_id: record.userId, servidor_id: record.guildId });
        } catch (error) {
          await log("mute_texto_error", { usuario_id: record.userId, codigo: error.code || "restauracion pendiente" });
        }
      }
    });
  }
  async function syncChannel(channel) {
    if (!supportsTextMute(channel)) return;
    return serial(async () => {
      await load();
      const active = records.filter(record => record.guildId === channel.guild.id && !record.restoring && record.expiresAt > now());
      if (!active.length) return;
      const me = await channel.guild.members.fetchMe();
      for (const record of active) await restrict(record, channel, me, "Mantener mute de texto de TARS");
    });
  }
  async function syncGuild(guild) {
    // Recuperar canales creados mientras el bot estaba desconectado.
    await serial(load);
    if (!records.some(record => record.guildId === guild.id && !record.restoring && record.expiresAt > now())) return;
    for (const channel of (await guild.channels.fetch()).values()) await syncChannel(channel);
  }
  return { mute, unmute, sweep, syncChannel, syncGuild };
}

module.exports = { createTextMutes, TEXT_PERMISSIONS };
