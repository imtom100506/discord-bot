// Node 24 ejecuta este módulo TypeScript CommonJS sin compilación adicional.
const fs = require('node:fs');
const path = require('node:path');
const { BoundedMap } = require('../boundedMap');
const template = fs.readFileSync(path.join(__dirname, '../persona/sparkInspiredSystemPrompt.md'), 'utf8').trim();
const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

function classify(text: string) {
  const raw = normalize(text);
  const wake = /\btars\b/.test(raw);
  const value = raw.replace(/^(?:hey |oye |hola )?tars\b[\s,:]*/, '').replace(/[.!?¿¡]+$/g, '').trim();
  const commands = [
    ['stop', /^(?:deja de escuchar|no escuches|deafen|ensordece(?:te)?)$/],
    ['mute', /^(?:mute|muteate|silenciate|callate)$/],
    ['unmute', /^(?:unmute|desmuteate|vuelve a hablar)$/],
    ['repeat', /^(?:repite|repitelo|otra vez)$/],
    ['volume_up', /^(?:sube (?:el )?volumen)$/],
    ['volume_down', /^(?:baja (?:el )?volumen)$/],
    ['help', /^(?:ayuda|comandos)$/],
    ['moderation_help', /^(?:mutea|silencia|desmutea|expulsa|saca|banea|borra mensajes)\b.*$/],
    ['ping', /^(?:ping|estado)$/],
    ['summary', /^(?:resume|resume (?:lo que dijeron|el canal|la conversacion))$/],
  ] as const;
  const command = commands.find(([, re]) => re.test(value));
  if (command) return { kind: 'command', intent: command[0], wake, text: value };
  const humor = value.match(/^(?:humor|ajusta (?:el )?humor(?: a)?)\s+(\d{1,3})(?:\s*%| por ciento)?$/);
  if (humor) return { kind: 'command', intent: 'humor', value: Math.min(100, Number(humor[1])), wake, text: value };
  const image = value.match(/^(?:genera|crea) (?:una )?imagen (?:de |sobre )?(.+)$/);
  const search = value.match(/^(?:busca en (?:internet|la web)|busca)\s+(.+)$/);
  if (image || search) return { kind: 'tool', intent: image ? 'generate_image' : 'search_web', query: (image || search)![1], wake, text: value };
  const direct = /[?¿]/.test(text) || /^(?:que|como|cuando|donde|quien|por que|puedes|podrias|explica|dime|cuanto)\b/.test(value);
  return { kind: value ? 'question' : 'empty', wake, direct, text: value };
}

function createLowLatencyPipeline({ askAI, memory, execute, tools = {}, wakeRequired = true, humor = 75, now = Date.now }: any) {
  const cache = new BoundedMap(100);
  const prepared = new BoundedMap(64);
  let responses = 0;
  function prepare(key: string, userId: string, text: string) {
    const value = { intent: classify(text), ...memory.snapshot(key) };
    prepared.set(`${key}:${userId}`, value);
    return value; // Parciales: solo trabajo local, sin efectos ni llamadas al LLM.
  }
  async function run({ key, userId, name, text, signal, addressed = false, onSentence }: any) {
    signal.throwIfAborted();
    const intent = classify(text);
    const pre = prepared.get(`${key}:${userId}`);
    prepared.delete(`${key}:${userId}`);
    if (intent.kind === 'empty' || (wakeRequired && !addressed && !intent.wake && !intent.direct)) return { ignored: true };
    const say = async (reply: string) => { if (reply && onSentence) await onSentence(reply); return { reply }; };
    if (intent.kind === 'command') {
      if (intent.intent === 'humor') { humor = intent.value; cache.clear(); return say(`Humor al ${humor} por ciento.`); }
      if (intent.intent === 'summary') {
        const snap = memory.snapshot(key);
        return say(snap.messages.length ? snap.messages.map((m: any) => m.content).join(' ').slice(-600) : 'Todavía no hay conversación para resumir.');
      }
      return say(await execute(intent.intent, { userId, signal }));
    }
    if (intent.kind === 'tool') {
      const handler = tools[intent.intent];
      if (!handler) return say(`La herramienta ${intent.intent} aún no está configurada.`);
      return say(String(await handler({ query: intent.query, prompt: intent.query, signal, userId, channelKey: key })).slice(0, 600));
    }
    // Caché de respuestas estables, nunca de respuestas personales ni preguntas dependientes del contexto.
    const frequent: Record<string, string> = { hola: 'En línea. ¿Qué necesitas?', gracias: 'De nada. Eficiencia nominal.', 'quien eres': 'Soy TARS, el asistente de voz de este canal. Humor ajustable; paciencia en evaluación.' };
    if (frequent[intent.text]) {
      const cacheKey = `${key}:${humor}:${intent.text}`;
      let entry = cache.get(cacheKey);
      if (!entry || entry.expires < now()) { entry = { reply: frequent[intent.text], expires: now() + 300000 }; cache.set(cacheKey, entry); }
      return say(entry.reply);
    }
    const snapshot = pre && pre.revision === memory.revision(key) ? pre : memory.snapshot(key);
    const question = `[Usuario: ${String(name || userId).replace(/[\r\n\[\]]/g, ' ').slice(0, 60)}] dijo: ${JSON.stringify(text)}`;
    const reply = await askAI(userId, question, { voice: true, signal, onSentence,
      externalHistory: snapshot.messages, context: snapshot.context,
      voicePrompt: template.replace('{humor}', String(humor)), detailed: /\b(detall|paso a paso|explica en profundidad)/i.test(text) });
    signal.throwIfAborted();
    return { reply, suggestions: ++responses % 4 === 0 ? ['¿Quieres que resuma lo que dijeron?', '¿Que lo busque?'] : [] };
  }
  function clear(key: string) { for (const k of cache.keys()) if (k.startsWith(`${key}:`)) cache.delete(k); for (const k of prepared.keys()) if (k.startsWith(`${key}:`)) prepared.delete(k); }
  return { run, prepare, clear };
}
module.exports = { classify, createLowLatencyPipeline };
