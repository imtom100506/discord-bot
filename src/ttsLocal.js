// Servidor durante una sesión o generador de muestras por línea de comandos.
const { OfflineTts } = require('sherpa-onnx-node');
const { ttsConfig } = require('./localSpeech');
const { wav } = require('./voiceAudio');
const { profile } = require('./voiceProfile');
const start = performance.now();
const tts = new OfflineTts(ttsConfig());
function generate(text, speed = profile.speed) {
  const result = tts.generate({ text, sid: profile.speaker, speed });
  const pcm = Buffer.alloc(result.samples.length * 2);
  for (let i = 0; i < result.samples.length; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, result.samples[i])) * 32767), i * 2);
  // Bajar ligeramente el tono; la velocidad de síntesis compensa parte del cambio.
  return wav(pcm, Math.round(result.sampleRate * profile.pitchRate));
}
if (process.argv[2] === '--server') {
  process.on('message', msg => {
    try {
      if (String(msg.text).length > 280) throw Error('Fragmento demasiado largo');
      process.send({ id: msg.id, audio: generate(String(msg.text)) });
    }
    catch { process.send({ id: msg.id, error: true }); }
  });
  process.on('disconnect', () => process.exit(0));
  process.send({ ready: true });
} else {
  const output = generate(process.argv[2] || 'TARS operativo. Listo para recibir instrucciones.', process.argv[3] === '--countdown-number' ? 2 : profile.speed);
  process.stdout.write(output);
  if (process.env.TARS_SPEECH_BENCHMARK === 'true') console.error(JSON.stringify({ ms: Math.round(performance.now() - start), rssMB: Math.round(process.memoryUsage().rss / 1048576), audioSeconds: (output.length - 44) / 2 / output.readUInt32LE(24) }));
}
