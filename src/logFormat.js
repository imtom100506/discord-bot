const safeName = value => String(value).replace(/[\r\n*_`\[\]<>\\]/g, '').slice(0, 100);
const titles = {
  voz_error: 'Voz · Pausa o error', voz_respuesta: 'Voz · Respuesta', voz_respuesta_texto: 'Voz · Respuesta por texto',
  voz_conexion: 'Voz · Conectado', voz_desconexion: 'Voz · Desconectado', voz_control: 'Voz · Control',
  voz_autodestruccion_inicio: 'Voz · Autodestrucción', voz_audio_error: 'Voz · Error de audio',
  voz_tts_error: 'Voz · Error de síntesis', ia_proveedor_error: 'IA · Proveedor no disponible',
  comando: 'Comando', moderacion: 'Moderación', moderacion_denegada: 'Moderación · Denegada',
  conexion: 'TARS · En línea', mensaje: 'IA · Consulta', respuesta: 'IA · Respuesta',
};
const labels = { resultado: 'Resultado', error: 'Detalle', codigo: 'Código', motivo: 'Motivo',
  comando: 'Comando', limite: 'Límite local', servicio: 'Servicio', espera_segundos: 'Reintento en segundos',
  demora_ms: 'Demora (ms)', proveedor: 'Proveedor', control: 'Control' };
async function channelLabel(client, guildId, channelId, name) {
  if (!channelId) return 'Canal no aplicable';
  const guild = client.guilds?.cache.get(guildId);
  let channel = guild?.channels.cache.get(channelId) || client.channels?.cache?.get(channelId);
  if (!name && !channel && guild?.channels.fetch) {
    try { channel = await guild.channels.fetch(channelId); } catch { /* Nombre explícito como fallback. */ }
  }
  const label = `#${safeName(name || channel?.name || `canal-${channelId}`)}`;
  return guildId ? `[${label}](https://discord.com/channels/${guildId}/${channelId})` : label;
}
async function formatOperational(client, event, data, clean, timestamp) {
  const guild = client.guilds?.cache.get(data.servidor_id);
  const channel = await channelLabel(client, data.servidor_id, data.canal_id, data.canal_nombre);
  const actor = data.usuario_id || data.ejecutor_id;
  const title = titles[event] || safeName(event).replace(/_/g, ' ');
  const heading = `**${title}** · ${actor ? `<@${actor}>` : 'TARS'} · ${channel} · <t:${Math.floor(timestamp / 1000)}:f>`;
  const omitted = /token|secret|password|api.?key|mensaje|respuesta|transcrip|audio|contenido|texto/i;
  const context = new Set(['servidor_id', 'canal_id', 'canal_nombre', 'usuario_id', 'ejecutor_id', 'usuario', 'canal', 'ejecutor']);
  const lines = Object.entries(data).filter(([key, value]) => value != null && !context.has(key) && !omitted.test(key))
    .map(([key, value]) => `**${labels[key] || safeName(key).replace(/_/g, ' ')}:** ${clean(value)}`);
  if (data.servidor_id) lines.push(`**Servidor:** ${clean(guild?.name || data.servidor_id)}`);
  return `${heading}\n${lines.join(' · ')}`.slice(0, 1900);
}
module.exports = { channelLabel, formatOperational };
