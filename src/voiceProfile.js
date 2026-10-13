// Una sola identidad compartida por generación, pregeneración y caché.
const profile = Object.freeze({ model: 'vits-piper-es_MX-ald-medium', modelFile: 'es_MX-ald-medium.onnx',
  archiveSha256: 'c60cf7bc853eb01a875fba0756523fecf9d9f46c763b19785d223fc981fb4fb6',
  speaker: 0, speed: 1.12, pitchRate: 0.84, noiseScale: 0.5, noiseScaleW: 0.6, lengthScale: 1,
  runtime: require('sherpa-onnx-node/package.json').version, format: 'pcm16-mono-wav', revision: 2 });
const profileId = require('node:crypto').createHash('sha256').update(JSON.stringify(profile)).digest('hex');
function speechParts(text) {
  return (String(text).normalize('NFC').replace(/https?:\/\/\S+/g, '').replace(/[*_`#<>]/g, '').replace(/\s+/g, ' ').trim()
    .match(/.{1,240}(?:\s|$)|\S{1,240}/gu) || []).map(part => part.trim()).filter(Boolean);
}
module.exports = { profile, profileId, speechParts };
