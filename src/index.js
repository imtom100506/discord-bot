require("dotenv").config();
process.on("uncaughtException", (err) => {
  console.error("ERROR:", err.message);
});
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { askAI, clearHistory } = require("./ai");
const keepAlive = require("./keepAlive");

// Mantener el servidor vivo en Render
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

const PREFIX = "!"; // Cambia tu prefijo aquí

client.once("ready", () => {
  console.log(`✅ Bot conectado como: ${client.user.tag}`);
  client.user.setActivity("!ayuda | IA activa 🤖", { type: "WATCHING" });
});

client.on("messageCreate", async (message) => {
  // Ignorar bots
  if (message.author.bot) return;

  const content = message.content.trim();

  // ── Comando: !ayuda ──────────────────────────────────
  if (content === `${PREFIX}ayuda`) {
    return message.reply(
      "🤖 **Comandos disponibles:**\n" +
        "`!chat <mensaje>` — Habla con la IA\n" +
        "`!reset` — Borra tu historial de conversación\n" +
        "`!ping` — Verifica si el bot está activo"
    );
  }

  // ── Comando: !ping ───────────────────────────────────
  if (content === `${PREFIX}ping`) {
    return message.reply(
      `🏓 Pong! Latencia: **${client.ws.ping}ms**`
    );
  }

  // ── Comando: !reset ──────────────────────────────────
  if (content === `${PREFIX}reset`) {
    clearHistory(message.author.id);
    return message.reply("🗑️ ¡Historial borrado! Empezamos de cero.");
  }

  // ── Comando: !chat <mensaje> ─────────────────────────
  if (content.startsWith(`${PREFIX}chat`)) {
    const userMessage = content.slice(`${PREFIX}chat`.length).trim();

    if (!userMessage) {
      return message.reply("⚠️ Escribe algo después de `!chat`");
    }

    // Mostrar "escribiendo..."
    await message.channel.sendTyping();

    try {
      const response = await askAI(message.author.id, userMessage);

      // Discord tiene límite de 2000 caracteres por mensaje
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
      message.reply("❌ Hubo un error al contactar la IA. Intenta de nuevo.");
    }

    return;
  }

  // ── Responder cuando mencionan al bot ────────────────
  if (message.mentions.has(client.user)) {
    const userMessage = content
      .replace(`<@${client.user.id}>`, "")
      .trim();

    if (!userMessage) {
      return message.reply("👋 ¡Hola! Usa `!chat <mensaje>` para hablar conmigo.");
    }

    await message.channel.sendTyping();

    try {
      const response = await askAI(message.author.id, userMessage);
      await message.reply(response);
    } catch (error) {
      console.error("Error con la IA:", error);
      message.reply("❌ Hubo un error. Intenta de nuevo.");
    }
  }
});

client.login(process.env.DISCORD_TOKEN);