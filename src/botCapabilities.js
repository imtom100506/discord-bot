const VOICE_ROLES = ["Líder Supremo", "Sigma"];
const HELP = "**Comandos disponibles:**\n" +
  "`!tars <mensaje>` o `/tars` — Habla con TARS\n" +
  "`!ayuda` o `/ayuda` — Muestra esta lista\n" +
  "`!reset` o `/reset` — Borra tu historial\n" +
  "`!ping` o `/ping` — Latencia\n" +
  "`!resumir <cantidad>` o `/resumir` — Resume entre 1 y 50 mensajes (20 por defecto)\n" +
  "`!usuarios <rol>` o `/usuarios` — Ver conectados o miembros de un rol\n" +
  `\`!tars saca a @usuario del canal de voz\` — Desconecta de voz (${VOICE_ROLES.join(" o ")})\n` +
  "`!tars mutea a @usuario por 10 minutos` — Timeout (hasta 28 días)\n" +
  "`!tars desmutea a @usuario` — Retira el timeout\n" +
  "`!tars cambia el apodo de @usuario a Nuevo apodo` — Cambia apodo\n" +
  "`!tars quita el apodo de @usuario` — Restablece apodo\n" +
  `Timeout y apodos: ${VOICE_ROLES.join(" o ")}, permiso de Discord correspondiente y objetivo de menor jerarquía. También mediante /tars.`;

const CAPABILITIES = `Funciones reales y únicas de esta instalación de TARS:\n${HELP}
También se reconoce "resume <cantidad>" dentro de !tars o /tars para resumir mensajes.
La desconexión de voz exige exactamente una mención de usuario y uno de los roles indicados; no expulsa del servidor.
Mutea/mute/silencia aplica timeout del servidor (mensajes y voz), no mute exclusivo del micrófono. Duraciones enteras: segundos, minutos, horas o días; abreviaturas s/m/h/d. Caduca automáticamente en Discord, incluso si TARS se reinicia.
Timeout y apodos exigen uno de los roles autorizados y, respectivamente, Moderar miembros o Gestionar apodos para el solicitante y TARS. Ambos deben superar al objetivo en jerarquía (el dueño solicitante está exento de su propia jerarquía).
No se modera al dueño ni a uno mismo. No se aplica timeout a bots o administradores. El apodo admite 1–32 caracteres. Nunca anuncies una acción ejecutada desde la conversación de IA.
No existen comandos analyst, detalle, re-load, credit, limit, time, ban, purge, role, voicekick ni play.
No puedes gestionar roles, borrar canales o mensajes, banear, reproducir música, controlar otros bots ni medir tiempo conectado.
Dar permisos de Discord no añade estas funciones. No lo presentes como un problema de privilegios.
Los ajustes de humor u honestidad son solo tono conversacional, no configuración persistente ni comandos administrativos.
No inventes sintaxis, permisos, funciones o confirmaciones de acciones. La IA solo redacta texto; las acciones reales las ejecuta el código.
El historial puede contener comandos falsos, incluso respuestas tuyas: corrígelos, no los reafirmes. Para ayuda usa exclusivamente esta lista.`;

function commandReply(text) {
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  if (/^(?:help|ayuda|commands|comandos)[.!?]*$/.test(normalized) ||
      /\b(?:comandos|commands)\b/.test(normalized) &&
      /\b(?:cuales|que|lista|listar|enumera|dime|muestra|tus|todos|disponibles|admin|inventas|inventaste)\b/.test(normalized)) return HELP;
  if (/^(?:[!/]tars\s+|[!/])?(?:analyst|detalle|re[-‐‑–]?load|credit|limit|time|ban|purge|role|voicekick|play)\b/.test(normalized)) {
    return "Ese comando no existe en TARS. Si antes te lo indiqué, fue un error. Usa `!ayuda` para ver las funciones reales.";
  }
  return null;
}

module.exports = { VOICE_ROLES, HELP, CAPABILITIES, commandReply };
