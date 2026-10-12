const fs = require('node:fs');
const path = require('node:path');

function createSileroVadFactory({ model = process.env.TARS_VAD_MODEL || path.join(__dirname, '../../models/silero_vad.onnx'), Vad } = {}) {
  function check() {
    if (!fs.existsSync(model)) throw Error('Falta Silero VAD. Ejecuta npm run models:download.');
    Vad ||= require('sherpa-onnx-node').Vad;
  }
  const factory = () => {
    check();
    let engine = new Vad({ sileroVad: { model, threshold: 0.5, minSpeechDuration: 0.1,
      minSilenceDuration: 0.1, windowSize: 512, maxSpeechDuration: 12 }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: false }, 15);
    return {
      frameBytes: 1024,
      process(pcm) {
        const samples = new Float32Array(pcm.length / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
        engine.acceptWaveform(samples);
        const active = engine.isDetected();
        while (!engine.isEmpty()) engine.pop();
        return active;
      },
      reset() { engine.reset(); },
      close() { engine?.clear(); engine = null; },
    };
  };
  factory.check = () => { const detector = factory(); detector.close(); };
  return factory;
}
module.exports = { createSileroVadFactory };
