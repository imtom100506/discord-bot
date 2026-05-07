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
  ],
  partials: [Partials.Channel],
});

const PREFIX = "!";

const commands = [
  new SlashCommandBuilder()
    .setName("tars")
    .setDescription("Habla con TARS")
    .addStringOption((option) =>
      option
        .setName("mensaje")
        .setDescription("Tu mensaje para TARS")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Borra tu historial de conversación con TARS"),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Verifica si TARS está activo"),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

client.once("ready", async () => {
  console.log(`✅ Bot conectado como: ${client.user.tag}`);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log("✅ Slash commands registrados");
  } catch (error) {
    console.error("Error registrando comandos:", error);
  }
});

// ── Slash commands ────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === "ping") {
    return interaction.reply(`Pong! Latencia: **${client.ws.ping}ms**`);
  }

  if (commandName === "reset") {
    clearHistory(interaction.user.id);
    return interaction.reply({
      content: "Historial borrado. Empezamos de cero.",
      ephemeral: true,
    });
  }

  if (commandName === "tars") {
    const userMessage = interaction.options.getString("mensaje");
    await interaction.deferReply();
    try {
      const response = await askAI(interaction.user.id, userMessage);
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
        "`!ping` o `/ping` — Verifica si TARS está activo"
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
    if (!userMessage) {
      return message.reply("Escribe algo después de `!tars`");
    }
    await message.channel.sendTyping();
    try {
      const response = await askAI(message.author.id, userMessage);
      if (response.length > 1900) {
        const chunks = response.match(/.{1,1900}/gs);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      } else {
        await message.reply(response);
      }
    } catch (error) {
      console.error("Error con la IA:", error);
      message.reply("Hubo un error. Intenta de nuevo.");
    }
  }
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error("Error al conectar con Discord:", err.message);
});