// Proceso efímero: libera el modelo y permite cancelar por timeout o /salir.
const { OfflineTts } = require('sherpa-onnx-node');
const { ttsConfig } = require('./localSpeech');
const { wav } = require('./voiceAudio');
const start = performance.now();
const tts = new OfflineTts(ttsConfig());
const result = tts.generate({ text: process.argv[2] || 'TARS operativo. Listo para recibir instrucciones.', sid: 0, speed: 1.06 });
const pcm = Buffer.alloc(result.samples.length * 2);
for (let i = 0; i < result.samples.length; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, result.samples[i])) * 32767), i * 2);
// Bajar ligeramente el tono; la velocidad de síntesis compensa parte del cambio.
process.stdout.write(wav(pcm, Math.round(result.sampleRate * 0.90)));
if (process.env.TARS_SPEECH_BENCHMARK === 'true') console.error(JSON.stringify({ ms: Math.round(performance.now() - start), rssMB: Math.round(process.memoryUsage().rss / 1048576), audioSeconds: pcm.length / 2 / (result.sampleRate * 0.9) }));
