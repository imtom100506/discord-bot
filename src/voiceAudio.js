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
  neural = require('./neuralSpeech').createNeuralSpeech() } = {}) {
  const execute = runImpl;
  let blockedUntil = 0;
  let neuralFailed = false;
  let warming = false;
  let generation = 0;
  async function warm() {
    if (env.TARS_TTS_ENGINE === 'espeak' || neuralFailed || warming) return;
    warming = true;
    const started = generation;
    try { await neural.warm(); }
    catch (error) { if (started === generation) { neuralFailed = true; console.warn('[voz:tts]', JSON.stringify({ phase: 'load', message: error.message, code: error.code })); } }
    finally { if (started === generation) warming = false; }
  }
  function close() { generation++; neural.close(); neuralFailed = false; warming = false; }
  let checked;
  function check() {
    // Binarios/modelos no cambian durante un despliegue: verificar una sola vez.
    checked ||= (async () => {
      if (!env.GROQ_API_KEY) throw new Error('Falta GROQ_API_KEY.');
      const checks = await Promise.allSettled([
        execute(env.TARS_ESPEAK_PATH || 'espeak-ng', ['--version'], { timeout: 5000, windowsHide: true }),
        execute('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true }),
      ]);
      const failed = checks.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (env.TARS_TTS_ENGINE !== 'espeak') require('./localSpeech').ttsConfig();
    })().catch(error => { checked = undefined; throw error; });
    return checked;
  }
  async function transcribe(pcm, signal) {
    const receivedBytes = pcm.length;
    if (!hasSpeech(pcm)) {
      console.info('[voz:audio]', JSON.stringify({ reason: receivedBytes ? 'below_energy_threshold' : 'empty_capture', receivedBytes }));
      return '';
    }
    if (now() < blockedUntil) throw new Error('Transcripción en pausa por límite del proveedor.');
    await budget.reserve({ audio: Math.max(10, Math.ceil(pcm.length / 32000)) });
    signal.throwIfAborted();
    const body = new FormData();
    body.set('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'pregunta.wav');
    body.set('model', 'whisper-large-v3-turbo'); body.set('language', 'es');
    body.set('response_format', 'json'); body.set('temperature', '0');
    const response = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` }, body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) {
      if (response.status === 429) {
        const { retryAfter } = require('./aiClient');
        blockedUntil = now() + retryAfter(response.headers.get('retry-after'), now());
      }
      throw new Error(`Transcripción no disponible (${response.status}).`);
    }
    const data = await response.json();
    if (typeof data.text !== 'string' || !data.text.trim()) console.info('[voz:audio]', JSON.stringify({ reason: 'empty_transcription', receivedBytes }));
    return typeof data.text === 'string' ? data.text.trim().slice(0, 800) : '';
  }
  async function synthesize(text, signal) {
    const spoken = text.replace(/https?:\/\/\S+/g, '').replace(/[*_`#<>]/g, '').slice(0, 280);
    if (env.TARS_TTS_ENGINE !== 'espeak' && !neuralFailed && !warming) {
      try {
        return await neural.synthesize(spoken, signal);
      } catch (error) {
        signal.throwIfAborted();
        neuralFailed = true;
        neural.close();
        console.warn('Síntesis neural no disponible; usando voz local ligera.');
      }
    }
    const { stdout } = await execute(env.TARS_ESPEAK_PATH || 'espeak-ng', ['-v', 'es-419+m3', '-p', '30', '-s', '155', '--stdout', '--', spoken], {
      encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 10000, windowsHide: true, signal,
    });
    return stdout;
  }
  return { check, transcribe, synthesize, warm, close };
}
module.exports = { wav, hasSpeech, trimSpeech, createVoiceAudio };
