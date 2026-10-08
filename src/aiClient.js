const { setTimeout: sleep } = require('node:timers/promises');
const { withAIRetry } = require('./aiRetry');
const { responseLimit, compactResponse } = require('./responsePolicy');

const unavailable = () => Object.assign(new Error('Los proveedores de IA no están disponibles.'), { code: 'AI_UNAVAILABLE' });

function retryAfter(value, now) {
  if (!value) return 60000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(1000, delay) : 60000;
}

function createAI({ systemPrompt, env = process.env, fetchImpl = global.fetch,
  wait = sleep, now = Date.now, spacingMs = 10000 } = {}) {
  const histories = new Map();
  const revisions = new Map();
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

  async function request(provider, messages) {
    if (provider.nextRequest > now()) await wait(provider.nextRequest - now());
    provider.nextRequest = now() + spacingMs;
    const body = { model: provider.model, messages, stream: false };
    if (provider.name === 'Groq') Object.assign(body, {
      max_completion_tokens: 2048, reasoning_effort: 'low', include_reasoning: false,
    });
    else body.max_tokens = 1024;
    let response;
    try {
      response = await fetchImpl(provider.url, {
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

  async function generate(messages) {
    if (!providers.length) throw Object.assign(new Error('Faltan credenciales de IA.'), { code: 'AI_CONFIG' });
    for (const provider of providers) {
      if (provider.blockedUntil > now()) continue;
      try {
        return await withAIRetry(() => request(provider, messages), { wait });
      } catch (error) {
        const status = error.cause?.status || error.status;
        if (status !== 429) provider.blockedUntil = now() + ([400, 401, 403, 404].includes(status) ? 300000 : 30000);
        console.warn(`[IA] ${provider.name} no disponible (${status || 'conexión'}); buscando respaldo.`);
      }
    }
    throw unavailable();
  }

  function askAI(userId, userMessage, { context = '', brief = false } = {}) {
    if (pending >= 8) return Promise.reject(Object.assign(new Error('Cola de IA llena.'), { code: 'AI_BUSY' }));
    pending++;
    const enqueued = now();
    const task = queue.then(async () => {
      if (now() - enqueued > 90000) throw Object.assign(new Error('La cola de IA tardó demasiado.'), { code: 'AI_BUSY' });
      const history = histories.get(userId) || [];
      const revision = revisions.get(userId) || 0;
      // Conserva ambos extremos para no perder la pregunta al final de un contexto largo.
      const clip = (text, max) => text.length <= max ? text : `${text.slice(0, max / 2)}\n[Contenido recortado]\n${text.slice(-max / 2)}`;
      const input = clip(String(userMessage), 6000);
      const limit = brief ? 600 : responseLimit(input);
      const messages = [{ role: 'system', content: `${systemPrompt}\nLímite de esta respuesta: ${limit} caracteres. Termina tus frases dentro de ese espacio.` }, ...history];
      messages.push({ role: 'user', content: context ? `Contexto del servidor:\n${clip(context, 3000)}\n\nPregunta: ${input}` : input });
      const reply = compactResponse(await generate(messages), limit);
      // No restaurar memoria si el usuario la borró mientras esperaba la respuesta.
      if ((revisions.get(userId) || 0) === revision) {
        const updated = [...history, { role: 'user', content: input }, { role: 'assistant', content: reply }];
        while (updated.length > 8 || updated.reduce((sum, msg) => sum + msg.content.length, 0) > 4000) updated.splice(0, 2);
        histories.set(userId, updated);
      }
      return reply;
    });
    queue = task.catch(() => {}).finally(() => { pending--; });
    return task;
  }

  function clearHistory(userId) {
    histories.delete(userId);
    revisions.set(userId, (revisions.get(userId) || 0) + 1);
  }
  return { askAI, clearHistory };
}

module.exports = { createAI, retryAfter };
