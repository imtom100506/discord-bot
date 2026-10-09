const { createWakeFactory } = require('./localSpeech');

// Tres hablantes simultáneos como máximo. Nunca mezcla audio entre usuarios.
function startWakeListener({ receiver, api, decoderFactory, detectorFactory, eligible, onWake, onError,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, followupEligible = () => false }) {
  const active = new Map();
  let stopped = false;
  let failures = [];
  function report(error, source, fatal = false) {
    failures = failures.filter(t => now() - t < 30000);
    failures.push(now());
    fatal ||= failures.length >= 3;
    console.warn('[voz:detector]', JSON.stringify({ source, fatal, name: error?.name,
      code: error?.code, message: String(error?.message || 'Error desconocido').slice(0, 180) }));
    if (fatal) stop();
    onError({ source, fatal });
  }
  function start(userId) {
    if (stopped || active.has(userId) || !eligible(userId)) return;
    // La continuación solo se abre para el interlocutor anterior.
    if (followupEligible(userId)) { onWake(userId); return; }
    if (active.size >= 3) return;
    let engine, input, decoder, timer, ended = false, pending = Buffer.alloc(0);
    function cleanup(transfer = false) {
      if (ended) return;
      ended = true; clearTimer(timer); active.delete(userId);
      decoder?.removeListener('data', data); decoder?.removeListener('end', end);
      decoder?.removeListener('error', decodeFail); input?.removeListener('error', inputFail);
      engine?.release(); engine = undefined;
      if (!transfer) {
        // Los streams pueden emitir un error tardío durante destroy().
        input?.on('error', () => {}); decoder?.on('error', () => {});
        input?.unpipe(decoder); input?.destroy(); decoder?.destroy();
      }
    }
    const end = () => cleanup();
    const fail = (error, source, fatal) => { if (ended) return; cleanup(); report(error, source, fatal); };
    const inputFail = error => fail(error, 'recepcion', false);
    const decodeFail = error => fail(error, 'opus', false);
    function data(chunk) {
      if (ended) return;
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
      } catch (error) { fail(error, 'modelo', true); }
    }
    try {
      engine = detectorFactory();
      input = receiver.subscribe(userId, { end: { behavior: api.EndBehaviorType.AfterSilence, duration: 900 } });
      decoder = decoderFactory(); active.set(userId, cleanup);
      cleanup.take = () => {
        const source = { input, decoder, initial: Buffer.from(pending) };
        cleanup(true);
        return source;
      };
      decoder.on('data', data); decoder.on('end', end);
      decoder.on('error', decodeFail); input.on('error', inputFail);
      // Límite por intervención; una transmisión continua no retiene recursos indefinidamente.
      timer = setTimer(end, 30000); timer?.unref?.();
      input.pipe(decoder);
    } catch (error) { fail(error, 'inicio', true); }
  }
  function pause() { for (const cleanup of [...active.values()]) cleanup(); }
  function stop() {
    if (stopped) return;
    stopped = true; receiver.speaking.removeListener('start', start); pause();
  }
  receiver.speaking.on('start', start);
  return { pause, stop, take: userId => active.get(userId)?.take() };
}
module.exports = { createWakeFactory, startWakeListener };
