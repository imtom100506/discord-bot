// Una sola identidad compartida por generación, pregeneración y caché.
const profile = Object.freeze({ model: 'vits-piper-es_MX-claude-high-int8', modelFile: 'es_MX-claude-high.onnx',
  archiveSha256: '0f9fc9c07d2e17bdc0f5f33a657addae92085da85704cb86a861e59d32f3bbfa',
  speaker: 0, speed: 1.06, pitchRate: 0.90, noiseScale: 0.5, noiseScaleW: 0.6, lengthScale: 1,
  runtime: require('sherpa-onnx-node/package.json').version, format: 'pcm16-mono-wav', revision: 1 });
const profileId = require('node:crypto').createHash('sha256').update(JSON.stringify(profile)).digest('hex');
function speechParts(text) {
  return (String(text).normalize('NFC').replace(/https?:\/\/\S+/g, '').replace(/[*_`#<>]/g, '').replace(/\s+/g, ' ').trim()
    .match(/.{1,240}(?:\s|$)|\S{1,240}/gu) || []).map(part => part.trim()).filter(Boolean);
}
module.exports = { profile, profileId, speechParts };
