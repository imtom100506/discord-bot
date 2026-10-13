const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function wav(pcm, rate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function trimSpeech(pcm) {
  // Ventanas de 20 ms: el silencio largo no diluye una respuesta breve como «sí».
  let first = -1, last = 0, voiced = 0;
  const length = pcm.length - pcm.length % 2;
  for (let offset = 0; offset < length; offset += 640) {
    const end = Math.min(offset + 640, length);
    let energy = 0;
    for (let i = offset; i < end; i += 2) energy += pcm.readInt16LE(i) ** 2;
    if (Math.sqrt(energy / ((end - offset) / 2)) <= 100) continue;
    if (first < 0) first = offset;
    last = end; voiced += end - offset;
  }
  if (voiced < 3200) return Buffer.alloc(0); // Menos de 100 ms: descartar golpes breves.
  return pcm.subarray(Math.max(0, first - 3200), Math.min(length, last + 3200));
}
function hasSpeech(pcm) {
  // Conservar el criterio anterior y aceptar además respuestas cortas.
  let energy = 0;
  const length = pcm.length - pcm.length % 2;
  for (let i = 0; i < length; i += 2) energy += pcm.readInt16LE(i) ** 2;
  return (length >= 8000 && Math.sqrt(energy / (length / 2)) > 100) || trimSpeech(pcm).length > 0;
}

function createVoiceAudio({ env = process.env, budget, fetchImpl = global.fetch, now = Date.now, runImpl = run,
  neural = require('./neuralSpeech').createNeuralSpeech(), cache } = {}) {
  const execute = runImpl;
  const { profileId, speechParts } = require('./voiceProfile');
  cache ||= require('./speechCache').createSpeechCache({ identity: profileId });
  let blockedUntil = 0;
  let ready;
  let queue = Promise.resolve(), pending = 0, failedUntil = 0;
  let generation = 0;
  function warm() {
    ready ||= Promise.resolve().then(() => neural.warm?.());
    return ready;
  }
  function close() { generation++; neural.close?.(); ready = undefined; failedUntil = 0; }
  let checked;
  function check() {
    // Binarios/modelos no cambian durante un despliegue: verificar una sola vez.
    checked ||= (async () => {
      if (env.TARS_STT_PROVIDER && env.TARS_STT_PROVIDER !== 'groq') throw new Error('El modo gratuito requiere TARS_STT_PROVIDER=groq. Deepgram usa créditos de pago.');
      if (env.TARS_TTS_ENGINE && env.TARS_TTS_ENGINE !== 'piper') throw new Error('La voz fija requiere TARS_TTS_ENGINE=piper. No se sustituirá por eSpeak.');
      if (!env.GROQ_API_KEY) throw new Error('Faltan credenciales de STT.');
      const checks = await Promise.allSettled([
        execute('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true }),
      ]);
      const failed = checks.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      require('./localSpeech').ttsConfig();
    })().catch(error => { checked = undefined; throw error; });
    return checked;
  }
  async function transcribe(pcm, signal) {
    const receivedBytes = pcm.length;
    if (!hasSpeech(pcm)) {
      console.info('[voz:audio]', JSON.stringify({ reason: receivedBytes ? 'below_energy_threshold' : 'empty_capture', receivedBytes }));
      return '';
    }
    if (now() < blockedUntil) throw Object.assign(new Error('Transcripción en pausa por límite del proveedor.'), { code: 'AI_BUDGET', scope: 'stt', reason: 'provider_429', retryAfterMs: blockedUntil - now() });
    await budget.reserve({ audio: Math.max(10, Math.ceil(pcm.length / 32000)) });
    signal.throwIfAborted();
    const body = new FormData();
    body.set('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'pregunta.wav');
    body.set('model', 'whisper-large-v3-turbo'); // Detectar idioma; no forzar traducción a español.
    body.set('response_format', 'json'); body.set('temperature', '0');
    const response = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` }, body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) {
      if (response.status === 429) {
        const { retryAfter } = require('./aiClient');
        blockedUntil = now() + retryAfter(response.headers.get('retry-after'), now());
        throw Object.assign(new Error(`El proveedor de transcripción pide esperar ${Math.ceil((blockedUntil - now()) / 1000)} segundos.`), { code: 'AI_BUDGET', scope: 'stt', reason: 'provider_429', retryAfterMs: blockedUntil - now() });
      }
      throw new Error(`Transcripción no disponible (${response.status}).`);
    }
    const data = await response.json();
    if (typeof data.text !== 'string' || !data.text.trim()) console.info('[voz:audio]', JSON.stringify({ reason: 'empty_transcription', receivedBytes }));
    return typeof data.text === 'string' ? data.text.trim().slice(0, 800) : '';
  }
  function synthesize(text, signal) {
    const parts = speechParts(text), epoch = generation;
    if (parts.length !== 1) return Promise.reject(Error('Sintetiza un fragmento de hasta 240 caracteres; no se recorta texto.'));
    if (pending >= 8) return Promise.reject(Error('Cola de síntesis llena'));
    pending++;
    const job = queue.then(async () => {
      const guard = () => { signal.throwIfAborted(); if (generation !== epoch) throw Error('Sesión de voz cerrada'); };
      guard();
      const spoken = parts[0], cached = await cache.get(spoken);
      guard(); if (cached) return cached;
      if (now() < failedUntil) throw Error('Voz temporalmente no disponible');
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const abort = () => neural.close?.();
          signal.addEventListener('abort', abort, { once: true });
          try { await warm(); } finally { signal.removeEventListener('abort', abort); }
          guard();
          const bytes = await neural.synthesize(spoken, signal);
          guard(); cache.put(spoken, bytes); return bytes;
        } catch (error) {
          guard(); neural.close?.(); ready = undefined;
          if (attempt === 1) { failedUntil = now() + 60000; throw error; }
        }
      }
    });
    const result = job.finally(() => { pending--; });
    queue = result.catch(() => {});
    return result;
  }
  async function countdown() {
    const bytes = await cache.get('TARS_COUNTDOWN_5_SECONDS_V1');
    if (!bytes) throw Error('Falta audio pregenerado de cuenta regresiva; ejecuta npm run voice:pregenerate.');
    return bytes;
  }
  return { check, transcribe, synthesize, countdown, warm, close };
}
module.exports = { wav, hasSpeech, trimSpeech, createVoiceAudio };
