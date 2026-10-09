const { createWakeFactory } = require('./localSpeech');

// Dos hablantes simultáneos como máximo. Nunca mezcla audio entre usuarios.
function startWakeListener({ receiver, api, decoderFactory, detectorFactory, eligible, onWake, onError,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const active = new Map();
  let stopped = false;
  function start(userId) {
    if (stopped || active.has(userId) || active.size >= 2 || !eligible(userId)) return;
    let engine, input, decoder, timer, ended = false, pending = Buffer.alloc(0);
    function cleanup(transfer = false) {
      if (ended) return;
      ended = true; clearTimer(timer); active.delete(userId);
      decoder?.removeListener('data', data); decoder?.removeListener('end', end);
      decoder?.removeListener('error', fail); input?.removeListener('error', fail);
      engine?.release(); engine = undefined;
      if (!transfer) { input?.unpipe(decoder); input?.destroy(); decoder?.destroy(); }
    }
    const end = () => cleanup();
    const fail = () => { cleanup(); stop(); onError(); };
    function data(chunk) {
      if (!eligible(userId)) return cleanup();
      try {
        pending = Buffer.concat([pending, chunk]);
        const bytes = engine.frameLength * 2;
        while (pending.length >= bytes) {
          const frame = new Int16Array(engine.frameLength);
          for (let i = 0; i < frame.length; i++) frame[i] = pending.readInt16LE(i * 2);
          pending = pending.subarray(bytes);
          if (engine.process(frame) >= 0) {
            const initial = Buffer.from(pending); pending = Buffer.alloc(0);
            cleanup(true);
            // Transferir los streams evita perder el comienzo de la pregunta.
            onWake(userId, { input, decoder, initial });
            return;
          }
        }
      } catch { fail(); }
    }
    try {
      engine = detectorFactory();
      input = receiver.subscribe(userId, { end: { behavior: api.EndBehaviorType.AfterSilence, duration: 900 } });
      decoder = decoderFactory(); active.set(userId, cleanup);
      decoder.on('data', data); decoder.on('end', end);
      decoder.on('error', fail); input.on('error', fail);
      // Límite por intervención; una transmisión continua no retiene recursos indefinidamente.
      timer = setTimer(end, 30000); timer?.unref?.();
      input.pipe(decoder);
    } catch { fail(); }
  }
  function pause() { for (const cleanup of [...active.values()]) cleanup(); }
  function stop() {
    if (stopped) return;
    stopped = true; receiver.speaking.removeListener('start', start); pause();
  }
  receiver.speaking.on('start', start);
  return { pause, stop };
}
module.exports = { createWakeFactory, startWakeListener };
