const MARKER = "TARS · Registro de mutes de texto · No borrar";
const FILE_NAME = "tars-text-mutes.json";

// Un mensaje del propio bot guarda el registro. No requiere disco de pago en Render.
function createDiscordMuteStore(client, channelId, fetchImpl = global.fetch) {
  let channel, message, lastSaved, located = false;
  async function locate() {
    if (located) return;
    channel = await client.channels.fetch(channelId);
    if (!channel?.messages || !channel.isTextBased()) throw new Error("El canal de estado de mutes debe ser de texto");
    let before;
    while (true) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      message = [...batch.values()].find(item => item.author.id === client.user.id && item.content === MARKER);
      if (message || batch.size < 100) break;
      before = batch.last().id;
    }
    located = true;
  }
  async function read() {
    await locate();
    if (!message) return null;
    const attachment = [...message.attachments.values()].find(item => item.name === FILE_NAME);
    if (!attachment) throw new Error("Falta el archivo del registro de mutes; no se sobrescribirá");
    const response = await fetchImpl(attachment.url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error("No se pudo leer el registro de mutes de Discord");
    lastSaved = await response.text();
    return lastSaved;
  }
  async function write(data) {
    await locate();
    if (message && data === lastSaved) return;
    const payload = { content: MARKER, attachments: [],
      files: [{ attachment: Buffer.from(data, "utf8"), name: FILE_NAME }], allowedMentions: { parse: [] } };
    if (message) message = await message.edit(payload);
    else message = await channel.send(payload);
    lastSaved = data;
  }
  return { read, write };
}

module.exports = { createDiscordMuteStore, MARKER };
