require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
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

client.once("ready", () => {
  console.log(`✅ Bot conectado como: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (content === `${PREFIX}ayuda`) {
    return message.reply(
      "**Comandos disponibles:**\n" +
        "`!tars <mensaje>` — Habla con TARS\n" +
        "`!reset` — Borra tu historial de conversación\n" +
        "`!ping` — Verifica si TARS está activo"
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