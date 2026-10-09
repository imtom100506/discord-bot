const { setTimeout: sleep } = require('node:timers/promises');
const { withAIRetry } = require('./aiRetry');
const { responseLimit, compactResponse } = require('./responsePolicy');
const { BoundedMap } = require('./boundedMap');

const unavailable = () => Object.assign(new Error('Los proveedores de IA no están disponibles.'), { code: 'AI_UNAVAILABLE' });
const clip = (text, max) => text.length <= max ? text : `${text.slice(0, max / 2)}\n[Contenido recortado]\n${text.slice(-max / 2)}`;

function retryAfter(value, now) {
  if (!value) return 60000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(1000, delay) : 60000;
}

function createAI({ systemPrompt, env = process.env, fetchImpl = global.fetch,
  wait = sleep, now = Date.now, spacingMs = 10000, maxHistories = 500 } = {}) {
  const histories = new BoundedMap(maxHistories);
  let activeHistory;
  const providers = [];
  if (env.GROQ_API_KEY) providers.push({
    name: 'Groq', key: env.GROQ_API_KEY,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'openai/gpt-oss-120b', blockedUntil: 0, nextRequest: 0,
  });
  if (env.CLOUDFLARE_API_TOKEN && /^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')) providers.push({
    name: 'Cloudflare', key: env.CLOUDFLARE_API_TOKEN,
    url: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,
    model: '@cf/google/gemma-4-26b-a4b-it', blockedUntil: 0, nextRequest: 0,
  });
  let queue = Promise.resolve();
  let pending = 0;
  let budget;

  async function request(provider, messages, voice = false) {
    if (provider.nextRequest > now()) await wait(provider.nextRequest - now());
    provider.nextRequest = now() + spacingMs;
    const body = { model: provider.model, messages, stream: false };
    if (provider.name === 'Groq') Object.assign(body, {
      max_completion_tokens: voice ? 512 : 2048, reasoning_effort: 'low', include_reasoning: false,
    });
    else body.max_tokens = voice ? 256 : 1024;
    if (budget) await budget.reserve({ tokens: Buffer.byteLength(JSON.stringify(messages), 'utf8') + (body.max_completion_tokens || body.max_tokens) });
    try {
      const response = await fetchImpl(provider.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      // Leer el cuerpo dentro del mismo manejo de errores y timeout.
      const data = await response.json();
      if (!response.ok || data.success === false) {
        const status = response.ok ? 503 : response.status;
        if (status === 429) provider.blockedUntil = now() + retryAfter(response.headers.get('retry-after'), now());
        // No registrar cuerpos ni cabeceras que puedan contener datos privados.
        throw Object.assign(new Error(`${provider.name}: HTTP ${status}`), { status });
      }
      const choice = data.choices?.[0];
      const text = choice?.message?.content?.trim();
      if (!text || choice.finish_reason === 'length') {
        throw Object.assign(new Error(`${provider.name}: respuesta vacía o incompleta`), { status: 503 });
      }
      return text;
    } catch (error) {
      if (error.status) throw error;
      // Fallos de red, JSON inválido y timeout son recuperables.
      throw Object.assign(new Error(`${provider.name}: fallo de conexión o respuesta`), { status: 503 });
    }
  }

  async function generate(messages, voice = false) {
    if (!providers.length) throw Object.assign(new Error('Faltan credenciales de IA.'), { code: 'AI_CONFIG' });
    for (const provider of providers) {
      if (provider.blockedUntil > now()) continue;
      try {
        return voice ? await request(provider, messages, true) : await withAIRetry(() => request(provider, messages), { wait });
      } catch (error) {
        if (error.code === 'AI_BUDGET' || error.cause?.code === 'AI_BUDGET') throw error.cause || error;
        const status = error.cause?.status || error.status;
        if (status !== 429) provider.blockedUntil = now() + ([400, 401, 403, 404].includes(status) ? 300000 : 30000);
        console.warn(`[IA] ${provider.name} no disponible (${status || 'conexión'}); buscando respaldo.`);
      }
    }
    throw unavailable();
  }

  function askAI(userId, userMessage, { context = '', brief = false, voice = false } = {}) {
    if (pending >= 8) return Promise.reject(Object.assign(new Error('Cola de IA llena.'), { code: 'AI_BUSY' }));
    pending++;
    const enqueued = now();
    const task = queue.then(async () => {
      if (now() - enqueued > 90000) throw Object.assign(new Error('La cola de IA tardó demasiado.'), { code: 'AI_BUSY' });
      const history = histories.get(userId) || [];
      const current = { userId, cleared: false };
      activeHistory = current;
      const input = clip(String(userMessage), 6000);
      const limit = voice ? 180 : brief ? 600 : responseLimit(input);
      const prompt = voice ? 'Eres TARS, robot con humor seco. Habla español conversacional: 1-2 frases breves, directas y listas para voz. Sin listas, Markdown ni saludos repetidos. Sigue el hilo; aclara solo si hace falta. No ejecutas acciones ni inventas recuerdos.' : systemPrompt;
      const messages = [{ role: 'system', content: `${prompt}\nLímite de esta respuesta: ${limit} caracteres. Termina tus frases dentro de ese espacio.` }, ...(voice ? history.slice(-2) : history)];
      messages.push({ role: 'user', content: context ? `Contexto del servidor:\n${clip(context, 3000)}\n\nPregunta: ${input}` : input });
      let reply;
      try { reply = compactResponse(await generate(messages, voice), limit); }
      finally { activeHistory = undefined; }
      // No restaurar memoria si el usuario la borró mientras esperaba la respuesta.
      if (!current.cleared) {
        const updated = [...history, { role: 'user', content: input }, { role: 'assistant', content: reply }];
        let characters = updated.reduce((sum, msg) => sum + msg.content.length, 0);
        while (updated.length > 8 || characters > 4000) {
          characters -= updated[0].content.length + updated[1].content.length;
          updated.splice(0, 2);
        }
        histories.set(userId, updated);
      }
      return reply;
    });
    queue = task.catch(() => {}).finally(() => { pending--; });
    return task;
  }

  function clearHistory(userId) {
    histories.delete(userId);
    if (activeHistory?.userId === userId) activeHistory.cleared = true;
  }
  return { askAI, clearHistory, setBudget: value => { budget = value; } };
}

module.exports = { createAI, retryAfter };
