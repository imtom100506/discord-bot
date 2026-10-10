const { PermissionFlagsBits } = require('discord.js');
const { VOICE_ROLES } = require('./botCapabilities');
const { MARKER } = require('./muteStore');
const active = new Set();
const pending = new Map();
const USAGE = 'Usa !borrar 10 o !borrar @usuario 10 (entre 1 y 100).';

function parseDelete(text) {
  const match = String(text || '').trim().match(/^(?:<@!?(\d+)>\s+)?([1-9]\d{0,2})$/);
  if (!match || Number(match[2]) > 100) return null;
  return { count: Number(match[2]), userId: match[1] };
}

async function deleteMessages(ctx, text, { sendLog = () => {}, clearContext = () => {}, now = Date.now, confirmedIds } = {}) {
  if (!ctx.guild) return ctx.reply('Usa este comando dentro de un servidor.');
  const request = parseDelete(text);
  if (!request) return ctx.reply(USAGE);
  if (!ctx.channel?.bulkDelete || !ctx.channel?.messages?.fetch) return ctx.reply('Este canal no admite el borrado de mensajes.');
  if (pending.has(ctx.channel.id)) return ctx.reply('Hay un borrado pendiente de confirmación en este canal.');
  if (active.has(ctx.channel.id)) return ctx.reply('Ya estoy limpiando este canal. Espera un momento.');
  active.add(ctx.channel.id);
  try {
    const actor = await ctx.guild.members.fetch({ user: ctx.user.id, force: true });
    if (!actor.roles.cache.some(role => VOICE_ROLES.includes(role.name))) return ctx.reply(`Necesitas el rol ${VOICE_ROLES.join(' o ')}.`);
    const permissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages];
    if (!ctx.channel.permissionsFor(actor)?.has(permissions)) return ctx.reply('Necesitas Ver canal, Leer historial y Gestionar mensajes en este canal.');
    const me = await ctx.guild.members.fetchMe({ force: true });
    if (!ctx.channel.permissionsFor(me)?.has(permissions)) return ctx.reply('TARS necesita Ver canal, Leer historial y Gestionar mensajes en este canal.');
    const messages = await ctx.channel.messages.fetch({ limit: 100, ...(ctx.messageId ? { before: ctx.messageId } : {}) });
    const oldest = now() - 14 * 86400000 + 60000;
    const selected = [...messages.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp)
      .filter(message => message.id !== ctx.messageId && !message.pinned && message.createdTimestamp > oldest &&
        (!request.userId || message.author.id === request.userId) && (!confirmedIds || confirmedIds.has(message.id)) &&
        !(message.author.id === me.id && [MARKER, 'TARS · Presupuesto IA · No borrar'].includes(message.content)))
      .slice(0, request.count);
    if (!selected.length) return ctx.reply('No encontré mensajes borrables entre los últimos 100. Omito fijados, registros internos y mensajes de 14 días o más.');
    if (request.count > 50 && !confirmedIds) {
      if (pending.size >= 100) return ctx.reply('Hay demasiadas confirmaciones pendientes. Inténtalo en un momento.');
      const confirmation = { guildId: ctx.guild.id, userId: ctx.user.id, text, messageId: ctx.messageId,
        ids: new Set(selected.map(message => message.id)), expires: now() + 30000 };
      pending.set(ctx.channel.id, confirmation);
      confirmation.timer = setTimeout(() => { if (pending.get(ctx.channel.id) === confirmation) pending.delete(ctx.channel.id); }, 30000);
      confirmation.timer.unref?.();
      try { return await ctx.reply(`Solicitaste borrar ${request.count} mensajes; encontré ${selected.length} borrables. ¿Estás seguro? Quien ejecutó el comando debe escribir «sí» o «no» aquí antes de 30 segundos.`); }
      catch (error) { clearTimeout(confirmation.timer); pending.delete(ctx.channel.id); throw error; }
    }
    const deleted = await ctx.channel.bulkDelete(selected.map(message => message.id), true);
    if (deleted.size) clearContext(ctx.channel.id);
    void sendLog('borrado', { ejecutor_id: ctx.user.id, canal_id: ctx.channel.id, objetivo_id: request.userId || 'todos', solicitados: request.count, borrados: deleted.size });
    return ctx.reply(`Borrados ${deleted.size} de ${request.count} mensajes solicitados. Reviso los últimos 100 y omito fijados, registros internos y mensajes antiguos.`);
  } catch (error) {
    void sendLog('borrado_error', { ejecutor_id: ctx.user.id, canal_id: ctx.channel.id, codigo: error.code || 'desconocido' });
    return ctx.reply('No pude completar el borrado. Revisa mis permisos y vuelve a intentarlo.');
  } finally { active.delete(ctx.channel.id); }
}

async function confirmDelete(ctx, text, options = {}) {
  const confirmation = pending.get(ctx.channel?.id);
  if (!confirmation || confirmation.guildId !== ctx.guild?.id || confirmation.userId !== ctx.user.id || !/^(?:s[ií]|no)$/i.test(text.trim())) return false;
  pending.delete(ctx.channel.id); clearTimeout(confirmation.timer);
  if ((options.now || Date.now)() >= confirmation.expires) { await ctx.reply('La confirmación venció. Ejecuta !borrar otra vez.'); return true; }
  if (/^no$/i.test(text.trim())) { await ctx.reply('Borrado cancelado.'); return true; }
  // Revalidar permisos y mensajes, conservando los IDs y el límite temporal originales.
  await deleteMessages({ ...ctx, messageId: confirmation.messageId }, confirmation.text, { ...options, confirmedIds: confirmation.ids });
  return true;
}
module.exports = { parseDelete, deleteMessages, confirmDelete };
