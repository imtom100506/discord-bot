require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const { askAI, clearHistory } = require("./ai");
const keepAlive = require("./keepAlive");

keepAlive();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Channel],
});

const PREFIX = "!";

const commands = [
  new SlashCommandBuilder()
    .setName("tars")
    .setDescription("Habla con TARS")
    .addStringOption((option) =>
      option.setName("mensaje").setDescription("Tu mensaje para TARS").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Borra tu historial de conversación con TARS"),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Verifica si TARS está activo"),
  new SlashCommandBuilder()
    .setName("ayuda")
    .setDescription("Muestra todos los comandos disponibles"),
  new SlashCommandBuilder()
    .setName("resumir")
    .setDescription("TARS resume los últimos mensajes del canal")
    .addIntegerOption((option) =>
      option.setName("cantidad").setDescription("Cuántos mensajes resumir (máx. 50)").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("usuarios")
    .setDescription("Lista usuarios conectados o con un rol específico")
    .addStringOption((option) =>
      option.setName("rol").setDescription("Nombre del rol a filtrar (opcional)").setRequired(false)
    ),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

client.once("ready", async () => {
  console.log(`✅ Bot conectado como: ${client.user.tag}`);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registrados");
  } catch (error) {
    console.error("Error registrando comandos:", error);
  }
});

// Función para obtener contexto del servidor
async function getServerContext(guild) {
  try {
    if (guild.members.cache.size < 2) {
      await guild.members.fetch();
    }
    const members = guild.members.cache;
    const online = members.filter((m) => !m.user.bot && m.presence?.status && m.presence?.status !== "offline");
    const total = members.filter((m) => !m.user.bot);
    return `Contexto del servidor "${guild.name}": ${total.size} miembros en total, ${online.size} conectados ahora mismo.`;
  } catch (error) {
    return `Contexto del servidor "${guild.name}".`;
  }
}

// ── Slash commands ────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === "ping") {
    return interaction.reply(`Pong! Latencia: **${client.ws.ping}ms**`);
  }

  if (commandName === "ayuda") {
    return interaction.reply({
      content:
        "**Comandos disponibles:**\n" +
        "`!tars <mensaje>` o `/tars` — Habla con TARS\n" +
        "`!reset` o `/reset` — Borra tu historial\n" +
        "`!ping` o `/ping` — Latencia\n" +
        "`!resumir <cantidad>` o `/resumir` — Resume los últimos mensajes\n" +
        "`!usuarios <rol>` o `/usuarios` — Ver usuarios conectados o por rol",
      ephemeral: true,
    });
  }

  if (commandName === "reset") {
    clearHistory(interaction.user.id);
    return interaction.reply({ content: "Historial borrado. Empezamos de cero.", ephemeral: true });
  }

  if (commandName === "usuarios") {
    await interaction.deferReply();
    if (interaction.guild.members.cache.size < 2) {
    await interaction.guild.members.fetch();
    }
    const rolNombre = interaction.options.getString("rol");

    if (rolNombre) {
      const rol = interaction.guild.roles.cache.find(
        (r) => r.name.toLowerCase() === rolNombre.toLowerCase()
      );
      if (!rol) return interaction.editReply(`No encontré el rol "${rolNombre}".`);
      const miembros = rol.members.filter((m) => !m.user.bot);
      const lista = miembros.map((m) => `- ${m.user.username}`).join("\n") || "Ninguno";
      return interaction.editReply(`**Usuarios con el rol "${rol.name}":**\n${lista}`);
    }

    const conectados = interaction.guild.members.cache.filter(
    (m) => !m.user.bot && m.presence?.status && m.presence?.status !== "offline"
    );
    const lista = conectados.map((m) => `- ${m.user.username}`).join("\n") || "Nadie conectado";
    return interaction.editReply(`**Usuarios conectados ahora:**\n${lista}`);
  }

  if (commandName === "resumir") {
    await interaction.deferReply();
    const cantidad = Math.min(interaction.options.getInteger("cantidad") || 20, 50);
    const mensajes = await interaction.channel.messages.fetch({ limit: cantidad });
    const historial = mensajes
      .reverse()
      .filter((m) => !m.author.bot)
      .map((m) => `${m.author.username}: ${m.content}`)
      .join("\n");

    if (!historial) return interaction.editReply("No hay mensajes para resumir.");

    try {
      const resumen = await askAI(
        interaction.user.id,
        `Resume estos mensajes del chat de Discord de forma breve y clara:\n\n${historial}`
      );
      await interaction.editReply(`**Resumen de los últimos ${cantidad} mensajes:**\n${resumen}`);
    } catch (error) {
      await interaction.editReply("Error al resumir. Intenta de nuevo.");
    }
  }

  if (commandName === "tars") {
    const userMessage = interaction.options.getString("mensaje");
    await interaction.deferReply();
    try {
      const serverCtx = await getServerContext(interaction.guild);
      const response = await askAI(interaction.user.id, `${serverCtx}\n\nPregunta: ${userMessage}`);
      await interaction.editReply(response);
    } catch (error) {
      console.error("Error con la IA:", error);
      await interaction.editReply("Hubo un error. Intenta de nuevo.");
    }
  }
});

// ── Prefix commands ───────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();

  if (content === `${PREFIX}ayuda`) {
    return message.reply(
      "**Comandos disponibles:**\n" +
        "`!tars <mensaje>` o `/tars` — Habla con TARS\n" +
        "`!reset` o `/reset` — Borra tu historial\n" +
        "`!ping` o `/ping` — Latencia\n" +
        "`!resumir <cantidad>` o `/resumir` — Resume los últimos mensajes\n" +
        "`!usuarios <rol>` o `/usuarios` — Ver usuarios conectados o por rol"
    );
  }

  if (content === `${PREFIX}ping`) {
    return message.reply(`Pong! Latencia: **${client.ws.ping}ms**`);
  }

  if (content === `${PREFIX}reset`) {
    clearHistory(message.author.id);
    return message.reply("Historial borrado. Empezamos de cero.");
  }

  if (content.startsWith(`${PREFIX}tars`)) {
    const userMessage = content.slice(`${PREFIX}tars`.length).trim();
    if (!userMessage) return message.reply("Escribe algo después de `!tars`");
    await message.channel.sendTyping();
    try {
      const serverCtx = await getServerContext(message.guild);
      const response = await askAI(message.author.id, `${serverCtx}\n\nPregunta: ${userMessage}`);
      if (response.length > 1900) {
        const chunks = response.match(/.{1,1900}/gs);
        for (const chunk of chunks) await message.reply(chunk);
      } else {
        await message.reply(response);
      }
    } catch (error) {
      console.error("Error con la IA:", error);
      message.reply("Hubo un error. Intenta de nuevo.");
    }
  }
  if (content.startsWith(`${PREFIX}resumir`)) {
    const cantidad = Math.min(parseInt(content.split(" ")[1]) || 20, 50);
    await message.channel.sendTyping();
    const mensajes = await message.channel.messages.fetch({ limit: cantidad });
    const historial = mensajes
      .reverse()
      .filter((m) => !m.author.bot)
      .map((m) => `${m.author.username}: ${m.content}`)
      .join("\n");

    if (!historial) return message.reply("No hay mensajes para resumir.");

    try {
      const resumen = await askAI(
        message.author.id,
        `Resume estos mensajes del chat de Discord de forma breve y clara:\n\n${historial}`
      );
      message.reply(`**Resumen de los últimos ${cantidad} mensajes:**\n${resumen}`);
    } catch (error) {
      message.reply("Error al resumir. Intenta de nuevo.");
    }
  }

  if (content.startsWith(`${PREFIX}usuarios`)) {
    const args = content.split(" ");
    const rolNombre = args.slice(1).join(" ");

    await message.guild.members.fetch();

    if (rolNombre) {
      const rol = message.guild.roles.cache.find(
        (r) => r.name.toLowerCase() === rolNombre.toLowerCase()
      );
      if (!rol) return message.reply(`No encontré el rol "${rolNombre}".`);
      const miembros = rol.members.filter((m) => !m.user.bot);
      const lista = miembros.map((m) => `- ${m.user.username}`).join("\n") || "Ninguno";
      return message.reply(`**Usuarios con el rol "${rol.name}":**\n${lista}`);
    }

    const conectados = message.guild.members.cache.filter(
      (m) => !m.user.bot && m.presence?.status && m.presence?.status !== "offline"
    );
    const lista = conectados.map((m) => `- ${m.user.username}`).join("\n") || "Nadie conectado";
    return message.reply(`**Usuarios conectados ahora:**\n${lista}`);
  }
});

console.log("Token cargado:", process.env.DISCORD_TOKEN ? "SI" : "NO");
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error("Error al conectar con Discord:", err.message);
});