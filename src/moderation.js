const { PermissionFlagsBits } = require("discord.js");
const { mentionedUserId } = require("./commandUtils");
const { VOICE_ROLES } = require("./botCapabilities");

const MAX_TIMEOUT = 28 * 24 * 60 * 60 * 1000;
const USAGE = "Usa `!tars mutea a @usuario por 10 minutos`, `!tars desmutea a @usuario`, " +
  "`!tars cambia el apodo de @usuario a Nuevo apodo` o `!tars quita el apodo de @usuario`.";

function parseDuration(text) {
  const match = text.trim().match(/^(\d+)\s*(s|segundos?|m|min|minutos?|h|horas?|d|d[ií]as?)$/i);
  if (!match) return null;
  const unit = match[2][0].toLowerCase();
  const duration = Number(match[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return Number.isSafeInteger(duration) && duration >= 1000 && duration <= MAX_TIMEOUT ? duration : null;
}

function parseModeration(text) {
  // Solo órdenes explícitas al inicio; una pregunta o una cita no ejecuta acciones.
  if (!/^(?:mutea|mute|silencia|desmutea|unmute|quita el (?:mute|silencio)|(?:cambia|cambiar|quita|restablece) (?:el )?apodo|apodo)\b/i.test(text)) return null;
  const targetId = mentionedUserId(text);
  if (!targetId) return { error: `Menciona exactamente a un usuario. ${USAGE}` };
  let match = text.match(/^(?:mutea|mute|silencia)\s+(?:a\s+)?<@!?\d+>\s+(?:por\s+|durante\s+)?(.+)$/i);
  if (match) {
    const duration = parseDuration(match[1]);
    return duration ? { type: "timeout", targetId, duration, durationLabel: match[1].trim() }
      : { error: "Indica una duración entera entre 1 segundo y 28 días. Ejemplos: `10 minutos`, `24 horas`, `30m`." };
  }
  if (/^(?:desmutea|unmute|quita el (?:mute|silencio))\s+(?:a\s+)?<@!?\d+>$/i.test(text)) {
    return { type: "untimeout", targetId };
  }
  if (/^(?:quita|restablece) (?:el )?apodo\s+(?:de\s+|a\s+)?<@!?\d+>$/i.test(text)) {
    return { type: "nickname", targetId, nickname: null };
  }
  match = text.match(/^(?:(?:cambia|cambiar) (?:el )?apodo\s+(?:de\s+|a\s+)?<@!?\d+>\s+a\s+|apodo\s+<@!?\d+>\s+)(.+)$/i);
  if (match) {
    const nickname = match[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)'|“([\s\S]*)”)$/, (_, a, b, c) => a ?? b ?? c).trim();
    if (!nickname || [...nickname].length > 32 || /[\u0000-\u001f\u007f]/.test(nickname)) {
      return { error: "El apodo debe tener entre 1 y 32 caracteres y ocupar una sola línea." };
    }
    return { type: "nickname", targetId, nickname };
  }
  return { error: USAGE };
}

async function moderate(ctx, action, sendLog) {
  if (!ctx.guild) return ctx.reply("Este comando solo está disponible dentro de un servidor.");
  if (action.error) return ctx.reply(action.error);
  const details = { ejecutor: ctx.user.username, ejecutor_id: ctx.user.id, objetivo_id: action.targetId, accion: action.type };
  const deny = async message => {
    void sendLog("moderacion_denegada", { ...details, motivo: message });
    return ctx.reply(message);
  };
  try {
    const actor = await ctx.guild.members.fetch({ user: ctx.user.id, force: true });
    const isNickname = action.type === "nickname";
    const permission = isNickname ? PermissionFlagsBits.ManageNicknames : PermissionFlagsBits.ModerateMembers;
    const permissionName = isNickname ? "Gestionar apodos" : "Moderar miembros";
    if (!actor.roles.cache.some(role => VOICE_ROLES.includes(role.name))) {
      return deny(`Necesitas el rol ${VOICE_ROLES.join(" o ")} para usar esta función.`);
    }
    if (!actor.permissions.has(permission)) return deny(`Necesitas el permiso «${permissionName}».`);
    const target = await ctx.guild.members.fetch({ user: action.targetId, force: true });
    if (target.id === ctx.user.id || target.id === ctx.guild.ownerId) {
      return deny("No puedes usar esta función sobre ti mismo ni sobre el dueño del servidor.");
    }
    if (ctx.user.id !== ctx.guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
      return deny("Solo puedes moderar a miembros con un rol inferior al tuyo.");
    }
    const me = await ctx.guild.members.fetchMe({ force: true });
    if (!me.permissions.has(permission)) return deny(`TARS necesita el permiso «${permissionName}».`);
    if (!target.manageable) return deny("El rol de TARS debe estar por encima del usuario objetivo; no puedo modificarme a mí mismo.");
    if (!isNickname && (target.user.bot || !target.moderatable)) {
      return deny("No puedo aplicar ni quitar timeout a bots o administradores.");
    }
    const reason = `Solicitado por ${ctx.user.username} (${ctx.user.id}) mediante TARS`;
    if (isNickname) await target.setNickname(action.nickname, reason);
    else await target.timeout(action.type === "timeout" ? action.duration : null, reason);
    void sendLog("moderacion", { ...details, apodo: action.nickname ?? "", duracion_ms: action.duration ?? 0 });
  } catch (error) {
    void sendLog("moderacion_error", { ...details, codigo: error.code || "desconocido" });
    if (error.code === 10007) return ctx.reply("No encontré a ese miembro en el servidor.");
    if (error.code === 50013 || error.code === 50001) return ctx.reply("Discord rechazó la acción. Revisa los permisos y la jerarquía de roles de TARS.");
    return ctx.reply("No pude completar la acción de moderación. Intenta de nuevo.");
  }
  // Confirmar únicamente después de que Discord acepte la operación.
  if (action.type === "timeout") return ctx.reply(`Silenciado <@${action.targetId}> por ${action.durationLabel}.`);
  if (action.type === "untimeout") return ctx.reply(`Timeout retirado a <@${action.targetId}>.`);
  return ctx.reply(action.nickname === null ? `Apodo restablecido para <@${action.targetId}>.` : `Apodo actualizado para <@${action.targetId}>.`);
}

module.exports = { parseDuration, parseModeration, moderate };
