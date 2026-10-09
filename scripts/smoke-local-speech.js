const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createWakeFactory } = require('../src/localSpeech');
const sherpa = require('sherpa-onnx-node');
const dir = path.resolve(__dirname, '../data/voice-research');
fs.mkdirSync(dir, { recursive: true });
if (!process.argv[2]) throw Error('Uso: node scripts/smoke-local-speech.js archivo-positivo.wav [otro-positivo.wav]');
const cases = process.argv.slice(2).map((file, i) => [`activation-${i}`, null, true, path.resolve(file)]);
cases.push(['background', 'Vamos a jugar otra partida. Después podemos conversar sobre la película.', false]);
const factory = createWakeFactory({ TARS_WAKE_ENABLED: 'true' });
for (const [name, text, expected, supplied] of cases) {
  const file = supplied || path.join(dir, `${name}.wav`);
  if (!supplied) {
    const bytes = execFileSync(process.execPath, [path.resolve(__dirname, '../src/ttsLocal.js'), text], { timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    fs.writeFileSync(file, bytes);
  }
  const wave = sherpa.readWave(file);
  const samples = new sherpa.LinearResampler(wave.sampleRate, 16000).flush(wave.samples);
  const detector = factory();
  let detected = false;
  const start = performance.now(), cpu = process.cpuUsage();
  for (let offset = 0; offset < samples.length + 16000; offset += detector.frameLength) {
    const frame = new Int16Array(detector.frameLength);
    for (let i = 0; i < frame.length; i++) frame[i] = Math.max(-32768, Math.min(32767, Math.round((samples[offset + i] || 0) * 32767)));
    if (detector.process(frame) >= 0) detected = true;
  }
  const used = process.cpuUsage(cpu);
  console.log(JSON.stringify({ name, detected, expected, wallMs: Math.round(performance.now() - start), cpuMs: (used.user + used.system) / 1000, audioSeconds: samples.length / 16000, rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
  detector.release(); assert.equal(detected, expected, name);
}
factory.dispose();
