require("dotenv").config();
require("opusscript");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require("@discordjs/voice");
const gTTS = require("gtts");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("ffmpeg-static");
// Memoria de contexto por canal (últimos 50 mensajes)
const channelContext = new Map();

function addToChannelContext(channelId, username, content) {
  if (!channelContext.has(channelId)) {
    channelContext.set(channelId, []);
  }
  const context = channelContext.get(channelId);
  context.push(`${username}: ${content}`);
  if (context.length > 50) context.shift();
}

function getChannelContext(channelId) {
  const context = channelContext.get(channelId);
  if (!context || context.length === 0) return "";
  return "Contexto reciente del canal:\n" + context.join("\n") + "\n\n";
}
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
  ws: {
    large_threshold: 50,
  },
  rest: {
    timeout: 60000,
  },
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
    .setName("tts")
    .setDescription("TARS habla en el canal de voz")
    .addStringOption((option) =>
      option.setName("texto").setDescription("Texto que quieres que TARS diga").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("tts-salir")
    .setDescription("TARS sale del canal de voz"),
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

if (commandName === "tts") {
    const texto = interaction.options.getString("texto");
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      return interaction.reply({ content: "Debes estar en un canal de voz.", flags: 64 });
    }

    await interaction.reply({ content: `Reproduciendo: "${texto}"`, flags: 64 });

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      const audioPath = path.join(__dirname, `tts_${Date.now()}.mp3`);
      const tts = new gTTS(texto, "es");

      tts.save(audioPath, (err) => {
        if (err) return console.error("Error TTS:", err);

        const player = createAudioPlayer();
        const resource = createAudioResource(audioPath);

        connection.subscribe(player);
        player.play(resource);

        player.on(AudioPlayerStatus.Idle, () => {
          try { fs.unlinkSync(audioPath); } catch (e) {}
        });

        player.on("error", (error) => {
          console.error("Error reproduciendo audio:", error.message);
        });
      });

    } catch (error) {
      console.error("Error en TTS:", error);
    }
  }

  if (commandName === "tts-salir") {
    const connection = require("@discordjs/voice").getVoiceConnection(interaction.guild.id);
    if (connection) {
      connection.destroy();
      return interaction.reply("Desconectado del canal de voz.");
    }
    return interaction.reply({ content: "No estoy en ningún canal de voz.", ephemeral: true });
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

    // Detectar si quiere kickear a alguien de voz
    const kickMatch = userMessage.match(/kick|expulsa|saca|bota|desconecta/i);
    if (kickMatch) {
      const rolesAutorizados = ["Líder Supremo", "Sigma"];
      const tienePermiso = interaction.member.roles.cache.some((r) =>
        rolesAutorizados.includes(r.name)
      );

      if (!tienePermiso) {
        return interaction.editReply("Negativo. No tienes rango suficiente para ordenarme eso.");
      }

      const target = interaction.options.resolved?.members?.first() ||
        interaction.guild.members.cache.find((m) =>
          userMessage.toLowerCase().includes(m.user.username.toLowerCase())
        );

      if (!target) {
        return interaction.editReply("Necesito que menciones al usuario. Ej: `/tars saca a @usuario del canal de voz`");
      }

      if (!target.voice.channel) {
        return interaction.editReply(`${target.user.username} no está en ningún canal de voz. Misión cancelada.`);
      }

      try {
        await target.voice.disconnect();
        return interaction.editReply(`Ejecutando comando. ${target.user.username} ha sido expulsado del canal de voz. Misión completada.`);
      } catch (error) {
        console.error("Error al kickear:", error);
        return interaction.editReply("Error en la operación. Verifica que tengo el permiso 'Mover miembros'.");
      }
    }
// Detectar si pide resumir
    const resumirMatch = userMessage.match(/resum[ei]/i);
    if (resumirMatch) {
      const numMatch = userMessage.match(/\d+/);
      const cantidad = numMatch ? parseInt(numMatch[0]) : 20;

      if (cantidad > 50) {
        return interaction.editReply(`Error. El máximo permitido es 50 mensajes. Intenta de nuevo con un número menor.`);
      }

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
        return interaction.editReply(`**Resumen de los últimos ${cantidad} mensajes:**\n${resumen}`);
      } catch (error) {
        return interaction.editReply("Error al resumir. Intenta de nuevo.");
      }
    }
    // Respuesta normal de IA
    try {
      const serverCtx = await getServerContext(interaction.guild);
      const channelCtx = getChannelContext(interaction.channelId);
      const response = await askAI(interaction.user.id, `${serverCtx}\n\n${channelCtx}Pregunta: ${userMessage}`);
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

  // Guardar mensaje en contexto del canal silenciosamente
  addToChannelContext(message.channel.id, message.author.username, message.content);

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

    // Detectar si quiere kickear a alguien de voz
    const kickMatch = userMessage.match(/kick|expulsa|saca|bota|desconecta/i);
    if (kickMatch) {
      const rolesAutorizados = ["Líder Supremo", "Sigma"];
      const tienePermiso = message.member.roles.cache.some((r) =>
        rolesAutorizados.includes(r.name)
      );

      if (!tienePermiso) {
        return message.reply("Negativo. No tienes rango suficiente para ordenarme eso.");
      }

      const target = message.mentions.members.first();

      if (!target) {
        return message.reply("Procesando... necesito que menciones al usuario. Ej: `!tars saca a @usuario del canal de voz`");
      }

      if (!target.voice.channel) {
        return message.reply(`${target.user.username} no está en ningún canal de voz. Misión cancelada.`);
      }

      try {
        await target.voice.disconnect();
        return message.reply(`Ejecutando comando. ${target.user.username} ha sido expulsado del canal de voz. Misión completada.`);
      } catch (error) {
        console.error("Error al kickear:", error);
        return message.reply("Error en la operación. Verifica que tengo el permiso 'Mover miembros'.");
      }
    }
// Detectar si pide resumir
    const resumirMatch = userMessage.match(/resum[ei]/i);
    if (resumirMatch) {
      const numMatch = userMessage.match(/\d+/);
      const cantidad = numMatch ? parseInt(numMatch[0]) : 20;

      if (cantidad > 50) {
        return message.reply(`Error. El máximo permitido es 50 mensajes. Intenta de nuevo con un número menor.`);
      }

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
        return message.reply(`**Resumen de los últimos ${cantidad} mensajes:**\n${resumen}`);
      } catch (error) {
        return message.reply("Error al resumir. Intenta de nuevo.");
      }
    }
    // Respuesta normal de IA
    try {
      const serverCtx = await getServerContext(message.guild);
      const channelCtx = getChannelContext(message.channel.id);
      const response = await askAI(message.author.id, `${serverCtx}\n\n${channelCtx}Pregunta: ${userMessage}`);
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

if (content.startsWith(`${PREFIX}tts`)) {
    const texto = content.slice(`${PREFIX}tts`.length).trim();

    if (texto.toLowerCase() === "salir") {
      const { getVoiceConnection } = require("@discordjs/voice");
      const connection = getVoiceConnection(message.guild.id);
      if (connection) {
        connection.destroy();
        return message.reply("Desconectado del canal de voz.");
      }
      return message.reply("No estoy en ningún canal de voz.");
    }

    if (!texto) {
      return message.reply("Escribe algo después de `!tts`. Ej: `!tts hola a todos`");
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply("Debes estar en un canal de voz para usar este comando.");
    }

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      const audioPath = path.join(__dirname, `tts_${Date.now()}.mp3`);
      const tts = new gTTS(texto, "es");

      tts.save(audioPath, (err) => {
        if (err) {
          console.error("Error TTS:", err);
          return message.reply("Error al generar el audio.");
        }

        const player = createAudioPlayer();
        const resource = createAudioResource(audioPath);

        connection.subscribe(player);
        player.play(resource);

        message.reply(`Reproduciendo: "${texto}"`);

        player.on(AudioPlayerStatus.Idle, () => {
          try { fs.unlinkSync(audioPath); } catch (e) {}
        });

        player.on("error", (error) => {
          console.error("Error reproduciendo audio:", error.message);
        });
      });

    } catch (error) {
      console.error("Error en TTS:", error);
      message.reply("Error al unirme al canal de voz.");
    }
  }
});

console.log("Token cargado:", process.env.DISCORD_TOKEN ? "SI" : "NO");
console.log("Intentando conectar a Discord...");
client.login(process.env.DISCORD_TOKEN).then(() => {
  console.log("Login exitoso");
}).catch((err) => {
  console.error("Error al conectar con Discord:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log("Estado del cliente:", client.ws.status);
}, 10000);