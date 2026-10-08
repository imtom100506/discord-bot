require("dotenv").config();
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { askAI, clearHistory } = require("./ai");
const keepAlive = require("./keepAlive");
const { summaryCount, countFromText, mentionedUserId, splitResponse } = require("./commandUtils");
const { VOICE_ROLES: ROLES_AUTORIZADOS, HELP, commandReply } = require("./botCapabilities");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel],
  ws: { large_threshold: 50 },
  rest: { timeout: 60000 },
  allowedMentions: { parse: [], repliedUser: false },
});
const channelContext = new Map();

async function sendLog(type, data) {
  if (!process.env.LOG_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
    if (!channel?.isTextBased() || typeof channel.send !== "function") return;
    const timestamp = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
    const details = Object.entries(data).map(([key, value]) => `${key}: ${String(value).slice(0, 400)}`).join("\n");
    await channel.send({ content: `[${timestamp}] **${type.toUpperCase()}**\n${details}`.slice(0, 1900), allowedMentions: { parse: [] } });
  } catch (error) {
    console.error("Error enviando log:", error.message);
  }
}

const commands = [
  new SlashCommandBuilder().setName("tars").setDescription("Habla con TARS")
    .addStringOption(o => o.setName("mensaje").setDescription("Tu mensaje para TARS").setRequired(true)),
  new SlashCommandBuilder().setName("reset").setDescription("Borra tu historial de conversación con TARS"),
  new SlashCommandBuilder().setName("ping").setDescription("Verifica si TARS está activo"),
  new SlashCommandBuilder().setName("ayuda").setDescription("Muestra todos los comandos disponibles"),
  new SlashCommandBuilder().setName("resumir").setDescription("TARS resume los últimos mensajes del canal")
    .addIntegerOption(o => o.setName("cantidad").setDescription("Mensajes a resumir (1 a 50)").setMinValue(1).setMaxValue(50)),
  new SlashCommandBuilder().setName("usuarios").setDescription("Lista usuarios conectados o con un rol específico")
    .addStringOption(o => o.setName("rol").setDescription("Nombre del rol a filtrar (opcional)")),
].map(command => command.toJSON());

client.once("ready", async () => {
  console.log(`Bot conectado como: ${client.user.tag}`);
  void sendLog("conexion", { bot: client.user.tag, servidores: client.guilds.cache.size });
  try {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("Slash commands registrados");
  } catch (error) {
    console.error("Error registrando comandos:", error);
  }
});

async function getServerContext(guild) {
  if (!guild) return "Conversación por mensaje privado.";
  const members = guild.members.cache.filter(member => !member.user.bot);
  const online = members.filter(member => member.presence?.status && member.presence.status !== "offline");
  return `Contexto del servidor "${guild.name}": ${members.size} miembros humanos en caché, ${online.size} conectados observados.`;
}

async function summarize(ctx, count) {
  const messages = await ctx.channel.messages.fetch({ limit: count });
  const selected = [...messages.values()].reverse().filter(message => !message.author.bot && message.id !== ctx.messageId);
  const history = selected.map(message => `${message.author.username}: ${message.content}`).join("\n");
  if (!history) return ctx.reply("No hay mensajes para resumir.");
  void sendLog("resumir", { usuario: ctx.user.username, canal: ctx.channel.name, cantidad: selected.length });
  const response = await askAI(ctx.user.id, `Resume estos mensajes del chat de Discord de forma breve y clara:\n\n${history}`, { brief: true });
  await ctx.reply(`**Resumen de ${selected.length} mensajes:**\n${response}`);
}

async function disconnect(ctx, text) {
  const member = await ctx.guild.members.fetch(ctx.user.id);
  if (!member.roles.cache.some(role => ROLES_AUTORIZADOS.includes(role.name))) {
    void sendLog("kick_denegado", { usuario: ctx.user.username });
    return ctx.reply("Negativo. No tienes rango suficiente para ordenarme eso.");
  }
  const targetId = mentionedUserId(text);
  if (!targetId) return ctx.reply("Menciona exactamente a un usuario. Ej: `!tars saca a @usuario del canal de voz`");
  const target = await ctx.guild.members.fetch(targetId).catch(error => {
    if (error.code === 10007) return null;
    throw error;
  });
  if (!target) return ctx.reply("No encontré a ese usuario en el servidor.");
  if (!target.voice.channelId) return ctx.reply(`${target.user.username} no está en ningún canal de voz.`);
  const voiceChannel = target.voice.channel?.name || target.voice.channelId;
  try {
    await target.voice.disconnect(`Solicitado por ${ctx.user.username} (${ctx.user.id})`);
  } catch (error) {
    console.error("Error kick:", error);
    void sendLog("error", { comando: "kick", usuario: ctx.user.username, error: error.message });
    return ctx.reply("Error en la operación. Verifica que tengo el permiso 'Mover miembros'.");
  }
  void sendLog("kick", { ejecutor: ctx.user.username, objetivo: target.user.username, canal: voiceChannel });
  await ctx.reply(`Ejecutando comando. ${target.user.username} expulsado del canal de voz. Misión completada.`);
}

async function execute(ctx, command, argument) {
  if (command === "ping") return ctx.reply(`Pong! Latencia: **${client.ws.ping}ms**`);
  if (command === "ayuda") return ctx.reply(HELP);
  if (command === "reset") {
    clearHistory(ctx.user.id);
    void sendLog("reset", { usuario: ctx.user.username });
    return ctx.reply("Historial borrado. Empezamos de cero.");
  }
  const text = String(argument ?? "").trim();
  const directReply = command === "tars" ? commandReply(text) : null;
  if (directReply) return ctx.reply(directReply);
  const isKick = command === "tars" && /\b(kick|expulsa|saca|bota|desconecta)\b/i.test(text);
  const isSummary = command === "resumir" || (command === "tars" && /\bresum(?:e|ir)\b/i.test(text));
  if (!ctx.guild && (command === "usuarios" || isKick || isSummary)) {
    return ctx.reply("Este comando solo está disponible dentro de un servidor.");
  }
  if (command === "usuarios") {
    await ctx.guild.members.fetch();
    void sendLog("usuarios", { usuario: ctx.user.username, filtro: text || "conectados" });
    const role = text ? ctx.guild.roles.cache.find(role => role.name.toLowerCase() === text.toLowerCase()) : null;
    if (text && !role) return ctx.reply(`No encontré el rol "${text}".`);
    const members = role ? role.members.filter(member => !member.user.bot) : ctx.guild.members.cache.filter(
      member => !member.user.bot && member.presence?.status && member.presence.status !== "offline");
    return ctx.reply(`**${role ? `Usuarios con el rol "${role.name}"` : "Usuarios conectados ahora"}:**\n` +
      (members.map(member => `- ${member.user.username}`).join("\n") || "Ninguno"));
  }
  if (isKick) return disconnect(ctx, text);
  if (isSummary) {
    let count;
    try { count = command === "resumir" ? summaryCount(argument) : countFromText(text); }
    catch (error) { return ctx.reply(error.message); }
    return summarize(ctx, count);
  }
  if (!text) return ctx.reply("Escribe algo después de `!tars`");
  void sendLog("mensaje", { usuario: ctx.user.username, canal: ctx.channel.name || "privado", mensaje: text });
  const serverContext = await getServerContext(ctx.guild);
  const recent = channelContext.get(ctx.channel.id) || [];
  const response = await askAI(ctx.user.id, text, {
    context: `${serverContext}\nUsuario que pregunta: ${ctx.user.username} (${ctx.user.id}).\n\nContexto reciente del canal:\n${recent.join("\n")}`,
  });
  void sendLog("respuesta", { usuario: ctx.user.username, respuesta: response });
  await ctx.reply(response);
}

async function handleError(ctx, error) {
  console.error("Error ejecutando comando:", error);
  void sendLog("error", { usuario: ctx.user.username, error: error.cause?.message || error.message || String(error) });
  if (error.code === 10062 || error.code === 10015) return;
  const response = error.code === "AI_UNAVAILABLE"
    ? "Los proveedores de IA están saturados o alcanzaron su cuota gratuita. Prueba de nuevo más tarde."
    : error.code === "AI_BUSY"
    ? "Tengo varias consultas pendientes. Prueba de nuevo en un momento."
    : error.code === "AI_CONFIG"
    ? "Falta configurar el acceso a la IA. Avísale a Tom."
    : "Hubo un error. Intenta de nuevo.";
  try { await ctx.reply(response); }
  catch (replyError) { console.error("No se pudo enviar el error:", replyError.message); }
}

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.isRepliable()) return;
  if (!commands.some(command => command.name === interaction.commandName)) return;
  const ctx = {
    user: interaction.user, guild: interaction.guild, channel: interaction.channel,
    reply: async text => {
      for (const chunk of splitResponse(text)) {
        const payload = { content: chunk, allowedMentions: { parse: [], repliedUser: false } };
        if (interaction.replied) await interaction.followUp(payload);
        else if (interaction.deferred) await interaction.editReply(payload);
        else await interaction.reply(payload);
      }
    },
  };
  try {
    await interaction.deferReply(["reset", "ayuda"].includes(interaction.commandName) ? { flags: 64 } : {});
    void sendLog("slash", { usuario: ctx.user.username, comando: interaction.commandName, canal: ctx.channel?.name || "privado" });
    const argument = interaction.commandName === "resumir" ? interaction.options.getInteger("cantidad") :
      interaction.commandName === "usuarios" ? interaction.options.getString("rol") :
      interaction.commandName === "tars" ? interaction.options.getString("mensaje") : null;
    await execute(ctx, interaction.commandName, argument);
  } catch (error) { await handleError(ctx, error); }
});

client.on("messageCreate", async message => {
  if (message.author.bot) return;
  const recent = channelContext.get(message.channel.id) || [];
  recent.push(`${message.author.username}: ${message.content}`);
  channelContext.set(message.channel.id, recent.slice(-50));
  const match = message.content.trim().match(/^!(tars|reset|ping|ayuda|resumir|usuarios)(?:\s+([\s\S]*))?$/i);
  if (!match) return;
  const ctx = {
    user: message.author, guild: message.guild, channel: message.channel, messageId: message.id,
    reply: async text => {
      for (const chunk of splitResponse(text)) {
        await message.reply({ content: chunk, allowedMentions: { parse: [], repliedUser: false } });
      }
    },
  };
  try {
    if (["tars", "resumir", "usuarios"].includes(match[1].toLowerCase())) await message.channel.sendTyping();
    await execute(ctx, match[1].toLowerCase(), match[2]);
  } catch (error) { await handleError(ctx, error); }
});

process.on("unhandledRejection", error => {
  console.error("Error no manejado:", error);
  void sendLog("error_fatal", { error: error?.message || String(error) });
});
client.on("error", error => {
  console.error("Error del cliente Discord:", error);
  void sendLog("error_fatal", { error: error.message });
});

keepAlive();
client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error("Error al conectar con Discord:", error.message);
  process.exitCode = 1;
  process.exit(1);
});
