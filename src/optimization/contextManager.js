const fs = require('node:fs/promises');
const path = require('node:path');
const { BoundedMap } = require('../boundedMap');
const clean = (text, length = 180) => String(text).replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, length);

function createContextManager({ file = path.join(process.env.TARS_DATA_DIR || 'data', 'channelMemory.json'), persist = true } = {}) {
  const channels = new BoundedMap(100);
  let loaded, writes = Promise.resolve();
  async function load() {
    loaded ||= (async () => {
      if (!persist) return;
      try {
        const stat = await fs.stat(file);
        if (stat.size > 4 * 1024 * 1024) throw Error('Memoria demasiado grande');
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.channels)) throw Error('Memoria inválida');
        for (const [key, value] of data.channels.slice(-100)) {
          if (typeof key !== 'string' || !Array.isArray(value.users) || !Array.isArray(value.topics) || !Array.isArray(value.jokes)) continue;
          channels.set(key, { ...empty(), users: value.users.slice(-50).filter(u => typeof u.id === 'string').map(u => ({ id: u.id, name: clean(u.name, 60), count: Math.min(Number(u.count) || 0, 100000), likes: (Array.isArray(u.likes) ? u.likes : []).slice(-5).map(v => clean(v)) })), topics: value.topics.slice(-10).map(v => clean(v)), jokes: value.jokes.slice(-10).map(v => clean(v)) });
          state(key).excluded = (Array.isArray(value.excluded) ? value.excluded : []).filter(id => typeof id === 'string').slice(-1000);
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    })();
    return loaded;
  }
  function empty() { return { users: [], topics: [], jokes: [], excluded: [], recent: [], digest: [], summary: '', messages: 0, revision: 0 }; }
  function state(key) {
    let s = channels.get(key);
    if (!s) {
      if (channels.size >= 100) {
        // Nunca olvidar una exclusión para hacer espacio a otro canal.
        const removable = [...channels].find(([, value]) => !value.excluded.length);
        if (!removable) throw Error('Capacidad de memoria agotada; se conservan las exclusiones existentes.');
        channels.delete(removable[0]);
      }
      s = empty(); channels.set(key, s);
    }
    return s;
  }
  function save() {
    if (!persist) return Promise.resolve();
    // Persistir solo recuerdos explícitos y usuarios frecuentes, nunca transcripciones crudas.
    const bytes = JSON.stringify({ version: 1, channels: [...channels].map(([key, s]) => [key, { users: s.users, topics: s.topics, jokes: s.jokes, excluded: s.excluded }]) });
    const task = writes.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file + '.tmp', bytes, { mode: 0o600 });
      await fs.rename(file + '.tmp', file);
    });
    writes = task.catch(() => {});
    return task;
  }
  function add(key, { userId, name, role, text }) {
    const s = state(key);
    const label = role === 'assistant' ? 'TARS' : clean(name || userId, 60);
    const entry = { role, content: role === 'assistant' ? clean(text, 600) : `[Usuario: ${label}] dijo: ${JSON.stringify(clean(text, 800))}` };
    s.recent.push(entry); s.recent = s.recent.slice(-6); s.messages++; s.revision++;
    s.digest.push(`${label}: ${clean(text, 100)}`);
    if (s.messages % 20 === 0) {
      // Resumen extractivo local: cero llamadas de IA en la ruta crítica.
      s.summary = [...new Set([s.summary, ...s.digest])].filter(Boolean).join(' | ').slice(-1400);
      s.digest = [];
    }
    if (role === 'user') {
      let user = s.users.find(u => u.id === userId);
      if (!user) { user = { id: userId, name: label, count: 0, likes: [] }; s.users.push(user); }
      user.name = label; user.count++;
      const like = String(text).match(/\bme gusta(?:n)?\s+(.+)/i);
      if (like) user.likes = [...new Set([...user.likes, clean(like[1])])].slice(-5);
      const topic = String(text).match(/\brecuerda (?:el )?tema[: ]+(.+)/i);
      const joke = String(text).match(/\brecuerda (?:la |esta )?broma[: ]+(.+)/i);
      if (topic) s.topics = [...new Set([...s.topics, clean(topic[1])])].slice(-10);
      if (joke) s.jokes = [...new Set([...s.jokes, clean(joke[1])])].slice(-10);
      s.users = s.users.sort((a, b) => b.count - a.count).slice(0, 50);
    }
    return entry.content;
  }
  function snapshot(key) {
    const s = state(key);
    return { revision: s.revision, messages: s.recent.map(v => ({ ...v })), context: JSON.stringify({ summary: s.summary, users: s.users.slice(0, 10), topics: s.topics, insideJokes: s.jokes }).slice(0, 3500) };
  }
  async function forget(key, userId) {
    const s = state(key);
    s.users = s.users.filter(u => u.id !== userId);
    // Los resúmenes y bromas pueden mencionar al usuario indirectamente: purgar todo lo derivado.
    s.topics = []; s.jokes = []; s.recent = []; s.digest = []; s.summary = ''; s.messages = 0; s.revision++;
    await save();
  }
  async function exclude(key, userId, value) {
    const s = state(key);
    if (value && !s.excluded.includes(userId) && s.excluded.length >= 1000) throw Error('Límite de exclusiones persistentes alcanzado.');
    s.excluded = value ? [...new Set([...s.excluded, userId])] : s.excluded.filter(id => id !== userId);
    await save();
  }
  async function forgetEverywhere(userId) { await load(); for (const key of [...channels.keys()]) await forget(key, userId); }
  return { load, add, snapshot, save, forget, forgetEverywhere, exclude, excluded: key => [...state(key).excluded], revision: key => state(key).revision };
}
module.exports = { createContextManager };
