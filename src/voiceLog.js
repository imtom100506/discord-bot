// Solo reutiliza texto ya producido. No llama a proveedores de IA.
function createVoiceLog(client) {
  let queue = Promise.resolve(), pending = 0;
  return function record({ guildId, channelId, userId, role, text }) {
    if (pending >= 20) {
      console.warn('[voz:registro] Cola llena; registro omitido.');
      return Promise.resolve();
    }
    pending++;
    const task = queue.then(async () => {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) throw Error('Servidor no disponible');
      const matches = channels => [...channels.values()].filter(c => c && c.name === 'logs-tars' && c.isTextBased() && typeof c.send === 'function');
      let channels = matches(guild.channels.cache);
      if (!channels.length) channels = matches(await guild.channels.fetch());
      if (channels.length !== 1) throw Error('Debe existir un único canal de texto logs-tars');
      const speaker = role === 'assistant' ? 'TARS' : `<@${userId}>`;
      await channels[0].send({
        content: `**Voz · ${speaker}** · <#${channelId}> · ${new Date().toISOString()}\n${String(text).slice(0, 1500)}`,
        allowedMentions: { parse: [] },
      });
    }).catch(error => console.warn('[voz:registro]', error.code || 'No se pudo enviar a logs-tars; revisa el canal y sus permisos.'))
      .finally(() => { pending--; });
    queue = task;
    return task;
  };
}
module.exports = { createVoiceLog };
