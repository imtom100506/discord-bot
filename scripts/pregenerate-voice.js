// Ejecutar en el PC; los WAV se incluyen en Docker sin inferencia en el arranque.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createVoiceAudio } = require('../src/voiceAudio');
const { createSpeechCache } = require('../src/speechCache');
const { profileId } = require('../src/voiceProfile');
const phrases = ['Escuchando a todo el canal', 'Voz activada.', 'Todavía no he respondido.',
  'Volumen subido.', 'Volumen bajado.', 'En línea.', 'En línea. ¿Qué necesitas?',
  'De nada. Eficiencia nominal.', 'Soy TARS, el asistente de voz de este canal. Humor ajustable; paciencia en evaluación.',
  'Puedes pedirme que repita, cambie el volumen o deje de escuchar. Usa privacidad en el chat para excluir tu voz.'];
async function main() {
  const directory = path.resolve(__dirname, '../audio/pregenerated');
  const cache = createSpeechCache({ identity: profileId, directory });
  const audio = createVoiceAudio({ cache });
  await fs.mkdir(directory, { recursive: true });
  const wanted = new Set(phrases.map(text => cache.key(text) + '.wav'));
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
    console.log(JSON.stringify({ profileId, files: phrases.length, bytes }));
  } finally { audio.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
