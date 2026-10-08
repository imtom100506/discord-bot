const VOICE_ROLES = ["Líder Supremo", "Sigma"];
const HELP = "**Comandos disponibles:**\n" +
  "`/entrar`, `/escuchar`, `/salir` (también con !) — Voz si está habilitada; preguntas de hasta 12 segundos, salida tras 10 minutos sin llamados\n" +
  "`!tars <mensaje>` o `/tars` — Habla con TARS\n" +
  "`!ayuda` o `/ayuda` — Muestra esta lista\n" +
  "`!reset` o `/reset` — Borra tu historial\n" +
  "`!ping` o `/ping` — Latencia\n" +
  "`!resumir <cantidad>` o `/resumir` — Resume entre 1 y 50 mensajes (20 por defecto)\n" +
  "`!usuarios <rol>` o `/usuarios` — Ver conectados o miembros de un rol\n" +
  `\`!tars saca a @usuario del canal de voz\` — Desconecta de voz (${VOICE_ROLES.join(" o ")})\n` +
  "`!tars mutea a @usuario por 10 minutos` — Mute solo de texto (hasta 28 días)\n" +
  "`!tars desmutea a @usuario` — Retira el mute de texto\n" +
  "`!tars cambia el apodo de @usuario a Nuevo apodo` — Cambia apodo\n" +
  "`!tars quita el apodo de @usuario` — Restablece apodo\n" +
  `Mute de texto y apodos: ${VOICE_ROLES.join(" o ")}, permiso de Discord correspondiente y objetivo de menor jerarquía. También mediante /tars.`;

const CAPABILITIES = `Funciones reales y únicas de esta instalación de TARS:\n${HELP}
También se reconoce "resume <cantidad>" dentro de !tars o /tars para resumir mensajes.
La voz requiere activación en el alojamiento. /entrar conecta, /escuchar captura solo la pregunta del solicitante y /salir desconecta. No escucha continuamente ni detecta el nombre TARS; sale tras 10 minutos sin llamados. Hablar entre usuarios no reinicia el contador.
La desconexión de voz exige exactamente una mención de usuario y uno de los roles indicados; no expulsa del servidor.
Mutea/mute/silencia bloquea solo mensajes, publicaciones e hilos en los canales del servidor, incluido el chat escrito de canales de voz. No afecta hablar ni conectarse a voz y no usa timeout. Duraciones enteras: segundos, minutos, horas o días; abreviaturas s/m/h/d.
TARS restaura los permisos anteriores al vencer (revisión cada 5 segundos); si está apagado, lo hace al volver. El registro persiste en el canal de estado/logs configurado o en disco persistente.
Mute de texto y apodos exigen uno de los roles autorizados y, respectivamente, Moderar miembros o Gestionar apodos para el solicitante. TARS necesita Gestionar roles/permisos en todos los canales para el mute o Gestionar apodos para el apodo. Ambos deben superar al objetivo en jerarquía (el dueño solicitante está exento de su propia jerarquía).
No se modera al dueño ni a uno mismo. No se aplica mute a bots o administradores. Un timeout antiguo se retira manualmente desde Discord antes de mutear solo texto. El apodo admite 1–32 caracteres. Nunca anuncies una acción ejecutada desde la conversación de IA.
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
