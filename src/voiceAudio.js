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

function hasSpeech(pcm) {
  if (pcm.length < 8000) return false;
  let energy = 0;
  for (let i = 0; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(energy / (pcm.length / 2)) > 100;
}

function createVoiceAudio({ env = process.env, budget, fetchImpl = global.fetch, now = Date.now, runImpl = run } = {}) {
  const execute = runImpl;
  let blockedUntil = 0;
  async function check() {
    if (!env.GROQ_API_KEY) throw new Error('Falta GROQ_API_KEY.');
    await execute(env.TARS_ESPEAK_PATH || 'espeak-ng', ['--version'], { timeout: 5000, windowsHide: true });
    await execute('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true });
    if (env.TARS_TTS_ENGINE !== 'espeak') require('./localSpeech').ttsConfig();
  }
  async function transcribe(pcm, signal) {
    if (!hasSpeech(pcm)) return '';
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
    return typeof data.text === 'string' ? data.text.trim().slice(0, 800) : '';
  }
  async function synthesize(text, signal) {
    const spoken = text.replace(/https?:\/\/\S+/g, '').replace(/[*_`#<>]/g, '').slice(0, 280);
    if (env.TARS_TTS_ENGINE !== 'espeak') {
      try {
        const { stdout } = await execute(process.execPath, [require.resolve('./ttsLocal'), spoken], {
          encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 45000, windowsHide: true, signal,
          env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' },
        });
        return stdout;
      } catch (error) {
        signal.throwIfAborted();
        console.warn('Síntesis neural no disponible; usando voz local ligera.');
      }
    }
    const { stdout } = await execute(env.TARS_ESPEAK_PATH || 'espeak-ng', ['-v', 'es-419+m3', '-p', '30', '-s', '155', '--stdout', '--', spoken], {
      encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 10000, windowsHide: true, signal,
    });
    return stdout;
  }
  return { check, transcribe, synthesize };
}
module.exports = { wav, hasSpeech, createVoiceAudio };
