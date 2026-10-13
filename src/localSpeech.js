const fs = require('node:fs');
const path = require('node:path');
const KWS_DIR = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20';
const TTS_DIR = 'vits-piper-es_ES-davefx-medium-int8';
const root = path.resolve(__dirname, '../models');
function required(file) {
  if (!fs.existsSync(file)) throw new Error('Faltan modelos locales. Ejecuta npm run models:download o reconstruye Docker.');
  return file;
}
function kwsConfig() {
  const model = name => required(path.join(root, KWS_DIR, name));
  const suffix = '-epoch-13-avg-2-chunk-16-left-64';
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: model('encoder' + suffix + '.int8.onnx'), decoder: model('decoder' + suffix + '.onnx'), joiner: model('joiner' + suffix + '.int8.onnx') },
      tokens: model('tokens.txt'), numThreads: 1, provider: 'cpu', debug: false },
    keywordsFile: required(path.join(root, 'hey-tars.txt')), maxActivePaths: 4,
    numTrailingBlanks: 1, keywordsScore: 1.5, keywordsThreshold: 0.25,
  };
}
function createWakeFactory(env = process.env) {
  if (env.TARS_WAKE_ENABLED !== 'true') return null;
  let spotter;
  const factory = () => {
    if (!spotter) {
      const config = kwsConfig();
      const { KeywordSpotter } = require('sherpa-onnx-node');
      spotter = new KeywordSpotter(config);
    }
    const engine = spotter;
    let stream = engine.createStream();
    return {
      frameLength: 1280, sampleRate: 16000,
      process(frame) {
        if (!stream) return -1;
        const samples = Float32Array.from(frame, v => v / 32768);
        stream.acceptWaveform({ sampleRate: 16000, samples });
        while (engine.isReady(stream)) {
          engine.decode(stream);
          if (engine.getResult(stream).keyword) { engine.reset(stream); return 0; }
        }
        return -1;
      },
      release() { stream = null; },
    };
  };
  factory.dispose = () => { spotter = null; };
  return factory;
}
function ttsConfig() {
  const model = name => required(path.join(root, TTS_DIR, name));
  return { model: { vits: { model: model('es_ES-davefx-medium.onnx'), tokens: model('tokens.txt'), dataDir: model('espeak-ng-data'),
    noiseScale: 0.5, noiseScaleW: 0.6, lengthScale: 1 }, numThreads: 1, provider: 'cpu', debug: false }, maxNumSentences: 1 };
}
module.exports = { createWakeFactory, kwsConfig, ttsConfig, KWS_DIR, TTS_DIR };
