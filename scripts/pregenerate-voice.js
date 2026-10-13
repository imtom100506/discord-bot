// Ejecutar en el PC; los WAV se incluyen en Docker sin inferencia en el arranque.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createVoiceAudio } = require('../src/voiceAudio');
const { createSpeechCache } = require('../src/speechCache');
const { profileId } = require('../src/voiceProfile');
const phrases = ['Escuchando a todo el canal', 'Voz activada.', 'Todavía no he respondido.',
  'Volumen subido.', 'Volumen bajado.', 'En línea.', 'En línea. ¿Qué necesitas?',
  'De nada. Eficiencia nominal.', 'Soy TARS, el asistente de voz de este canal. Humor ajustable; paciencia en evaluación.',
  'Puedes pedirme que repita, cambie el volumen o deje de escuchar. Puedes pedirme que salga o active la autodestrucción.'];
async function main() {
  const directory = path.resolve(__dirname, '../audio/pregenerated');
  const cache = createSpeechCache({ identity: profileId, directory });
  const audio = createVoiceAudio({ cache });
  await fs.mkdir(directory, { recursive: true });
  const wanted = new Set([...phrases, 'TARS_COUNTDOWN_5_SECONDS_V1'].map(text => cache.key(text) + '.wav'));
  // Solo archivos generados de esta carpeta; mantiene acotado el paquete entre perfiles.
  for (const name of await fs.readdir(directory)) {
    if (/^[a-f0-9]{64}\.wav$/.test(name) && !wanted.has(name)) await fs.unlink(path.join(directory, name));
  }
  let bytes = 0;
  try {
    for (const text of phrases) {
      const wav = await audio.synthesize(text, AbortSignal.timeout(90000));
      bytes += wav.length;
      if (bytes > 8 * 1024 * 1024) throw Error('Pregenerados exceden 8 MiB');
      await fs.writeFile(path.join(directory, cache.key(text) + '.wav'), wav);
    }
    // Cinco ranuras exactas de un segundo. Recorta solo silencio en cada número.
    let rate, countdown;
    for (const [index, number] of ['cinco', 'cuatro', 'tres', 'dos', 'uno'].entries()) {
      const digit = require('node:child_process').execFileSync(process.execPath, [require.resolve('../src/ttsLocal'), number, '--countdown-number'], { windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
      rate ||= digit.readUInt32LE(24);
      if (digit.readUInt32LE(24) !== rate) throw Error('Frecuencias distintas en cuenta regresiva');
      countdown ||= Buffer.alloc(rate * 2 * 5);
      const pcm = digit.subarray(44);
      let first = 0, last = pcm.length;
      while (first < last && Math.abs(pcm.readInt16LE(first)) < 100) first += 2;
      while (last > first && Math.abs(pcm.readInt16LE(last - 2)) < 100) last -= 2;
      first = Math.max(0, first - Math.floor(rate * 0.015) * 2);
      last = Math.min(pcm.length, last + Math.floor(rate * 0.03) * 2);
      if (last - first > rate * 2) throw Error('Número excede un segundo: revisar pregeneración');
      pcm.copy(countdown, index * rate * 2, first, last);
    }
    const countWav = require('../src/voiceAudio').wav(countdown, rate);
    await fs.writeFile(path.join(directory, cache.key('TARS_COUNTDOWN_5_SECONDS_V1') + '.wav'), countWav);
    bytes += countWav.length;
    console.log(JSON.stringify({ profileId, files: phrases.length, bytes }));
  } finally { audio.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
