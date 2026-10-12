const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
function validWav(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length > 44 && bytes.length <= 4 * 1024 * 1024 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE' &&
    bytes.readUInt32LE(4) + 8 === bytes.length && bytes.toString('ascii', 36, 40) === 'data' &&
    bytes.readUInt16LE(20) === 1 && bytes.readUInt16LE(22) === 1 && bytes.readUInt16LE(34) === 16 &&
    bytes.readUInt32LE(40) === bytes.length - 44 && bytes.readUInt32LE(24) >= 8000;
}
function createSpeechCache({ identity, maxBytes = 8 * 1024 * 1024, maxEntries = 64,
  directory = path.resolve(__dirname, '../audio/pregenerated') }) {
  const entries = new Map(); let size = 0;
  const key = text => createHash('sha256').update(identity + '\0' + text).digest('hex');
  function put(text, bytes) {
    if (!validWav(bytes)) throw Error('WAV incompleto o inválido');
    if (bytes.length > maxBytes) return;
    const id = key(text), old = entries.get(id);
    if (old) { size -= old.length; entries.delete(id); }
    entries.set(id, bytes); size += bytes.length;
    while (size > maxBytes || entries.size > maxEntries) {
      const first = entries.keys().next().value; size -= entries.get(first).length; entries.delete(first);
    }
  }
  async function get(text) {
    const id = key(text), hit = entries.get(id);
    if (hit) { entries.delete(id); entries.set(id, hit); return hit; }
    try {
      const file = path.join(directory, id + '.wav');
      if ((await fs.stat(file)).size > 4 * 1024 * 1024) return;
      const bytes = await fs.readFile(file);
      if (validWav(bytes)) { put(text, bytes); return bytes; }
    } catch { /* Ausente/corrupto: generar con el mismo perfil. */ }
  }
  return { get, put, key, stats: () => ({ bytes: size, entries: entries.size }) };
}
module.exports = { createSpeechCache, validWav };
