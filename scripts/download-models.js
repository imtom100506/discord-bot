const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { profile } = require('../src/voiceProfile');
const models = [
  { tag: 'kws-models', name: 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20', sha: '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6' },
  { tag: 'tts-models', name: profile.model, sha: profile.archiveSha256 },
];
async function main() {
  const dir = path.join(root, 'models');
  await fs.mkdir(dir, { recursive: true });
  const vad = await fetch('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx', { signal: AbortSignal.timeout(60000) });
  if (!vad.ok) throw Error(`No se pudo descargar Silero: ${vad.status}`);
  const vadBytes = Buffer.from(await vad.arrayBuffer());
  if (crypto.createHash('sha256').update(vadBytes).digest('hex') !== '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6') throw Error('Hash incorrecto: Silero VAD');
  await fs.writeFile(path.join(dir, 'silero_vad.onnx'), vadBytes);
  console.log('Modelo verificado: Silero VAD');
  if (process.argv.includes('--vad-only')) return;
  for (const m of models) {
    const response = await fetch(`https://github.com/k2-fsa/sherpa-onnx/releases/download/${m.tag}/${m.name}.tar.bz2`, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw Error(`No se pudo descargar ${m.name}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== m.sha) throw Error(`Hash incorrecto: ${m.name}`);
    const archive = path.join(dir, `${m.name}.tar.bz2`);
    await fs.writeFile(archive, bytes);
    try {
      const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
      if (entries.some(e => !e.startsWith(m.name + '/') || e.split('/').includes('..') || e.includes('\\'))) throw Error('Ruta de archivo no permitida');
      execFileSync('tar', ['-xf', archive, '-C', dir]);
      console.log(`Modelo verificado: ${m.name}`);
    } finally { await fs.unlink(archive); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
