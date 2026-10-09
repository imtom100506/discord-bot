const { fork } = require('node:child_process');

// Un proceso por sesión. El modelo permanece caliente sin bloquear Discord.
function createNeuralSpeech({ spawn = fork, timeoutMs = 15000 } = {}) {
  let child, ready, pending, sequence = 0;
  function close() {
    const old = child; child = undefined; ready = undefined;
    pending?.reject(new Error('Síntesis cancelada')); pending = undefined;
    old?.kill();
  }
  function warm() {
    if (ready) return ready;
    const current = spawn(require.resolve('./ttsLocal'), ['--server'], {
      silent: true, windowsHide: true, serialization: 'advanced',
      env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' },
    });
    child = current;
    // Consumir stderr para evitar llenar la tubería; no contiene conversaciones.
    current.stderr?.on('data', () => {});
    current.stdout?.on('data', () => {});
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Carga de voz demasiado lenta')); if (child === current) close(); }, timeoutMs);
      current.on('message', msg => {
        if (msg.ready) { clearTimeout(timer); resolve(); }
        else if (pending?.id === msg.id) {
          if (Buffer.isBuffer(msg.audio)) pending.resolve(msg.audio);
          else pending.reject(new Error('Síntesis neural fallida'));
        }
      });
      const fail = () => {
        clearTimeout(timer); reject(new Error('Proceso de voz cerrado'));
        if (child === current) close();
      };
      current.on('error', fail); current.on('exit', fail);
    });
    return ready;
  }
  async function synthesize(text, signal) {
    signal.throwIfAborted();
    const abortStartup = () => close();
    signal.addEventListener('abort', abortStartup, { once: true });
    try { await warm(); } finally { signal.removeEventListener('abort', abortStartup); }
    signal.throwIfAborted();
    if (pending) throw new Error('Síntesis ocupada');
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const done = (error, audio) => {
        if (pending?.id !== id) return;
        clearTimeout(timer); signal.removeEventListener('abort', abort); pending = undefined;
        if (error) reject(error); else resolve(audio);
      };
      const abort = () => { done(new Error('Síntesis cancelada')); close(); };
      const timer = setTimeout(() => { done(new Error('Síntesis demasiado lenta')); close(); }, timeoutMs);
      pending = { id, resolve: audio => done(null, audio), reject: error => done(error) };
      signal.addEventListener('abort', abort, { once: true });
      try { child.send({ id, text }, error => { if (error) { done(error); close(); } }); }
      catch (error) { done(error); close(); }
    });
  }
  return { warm, synthesize, close };
}
module.exports = { createNeuralSpeech };
