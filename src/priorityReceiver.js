// Modo manual: durante respuestas solo se transcriben intervenciones para controles.
// Reutiliza la recepción Opus/STT; límite de tres capturas y doce segundos por usuario.
function priorityReceiver({ s, api, decoderFactory, audio, onText, onError, setTimer, clearTimer, client }) {
  const active = new Map();
  const eligible = id => !s.closed && !s.capturing && (s.busy || s.countdown) &&
    id !== client.user.id && s.voiceChannel.members.has(id) && !s.voiceChannel.members.get(id).user.bot;
  function start(id) {
    if (!eligible(id) || active.has(id) || active.size >= 3) return;
    const previous = s.connection.receiver.subscriptions?.get(id);
    if (previous?.destroyed) return;
    const input = s.connection.receiver.subscribe(id, { end: { behavior: api.EndBehaviorType.AfterSilence, duration: 500 } });
    const decoder = decoderFactory();
    let bytes = 0, chunks = [], done = false, timer;
    const abort = new AbortController();
    const cleanup = () => { clearTimer(timer); input.unpipe(decoder); input.destroy(); decoder.destroy(); };
    const cancel = () => { done = true; abort.abort(); cleanup(); chunks = []; active.delete(id); };
    active.set(id, cancel);
    function finish() {
      if (done) return;
      done = true; cleanup();
      const pcm = Buffer.concat(chunks, bytes); chunks = [];
      const signal = AbortSignal.any([s.abort.signal, abort.signal]);
      Promise.resolve().then(() => audio.transcribe(pcm, signal)).then(text => {
        if (!signal.aborted && eligible(id)) onText(text, id);
      }).catch(error => { if (!signal.aborted) onError(error); }).finally(() => active.delete(id));
    }
    input.on('error', cancel); decoder.on('error', cancel);
    decoder.on('end', finish);
    decoder.on('data', chunk => {
      if (done) return;
      const kept = chunk.subarray(0, 384000 - bytes); chunks.push(kept); bytes += kept.length;
      if (bytes >= 384000) finish();
    });
    timer = setTimer(finish, 12000); timer?.unref?.(); input.pipe(decoder);
  }
  s.connection.receiver.speaking.on('start', start);
  return { stop() { s.connection.receiver.speaking.removeListener('start', start); for (const cancel of [...active.values()]) cancel(); } };
}
module.exports = { priorityReceiver };
