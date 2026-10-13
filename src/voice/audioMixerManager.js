// Multiplexación con identidad: nunca suma señales de distintos hablantes.
function createAudioMixerManager({ receiver, api, decoderFactory, vadFactory, eligible, acceptAudio = () => true, isPlayback = () => false, createStreaming,
  onPartial = () => {}, onUtterance, onError = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  endpointMs = 240, maxUsers = 100, maxPending = 8 }) {
  const users = new Map(), audioBuffers = new Map(), inflight = new Set(), streams = new Set();
  let stopped = false;
  function closeStream(stream) { stream?.cancel(); streams.delete(stream); }
  function reset(state) {
    clearTimer(state.timer);
    state.chunks = []; state.bytes = 0; state.voiced = 0; state.started = false; state.pre = Buffer.alloc(0);
    state.priorityOnly = false; state.lastSpeech = 0; state.stream = undefined; state.vad?.reset(); audioBuffers.delete(state.userId);
  }
  function cancel(userId) {
    const state = users.get(userId);
    if (state) {
      users.delete(userId); state.closed = true; clearTimer(state.timer); closeStream(state.stream);
      state.input.unpipe(state.decoder); state.input.destroy(); state.decoder.destroy(); state.vad?.close(); audioBuffers.delete(userId);
    }
    for (const job of inflight) if (job.userId === userId) job.abort.abort();
  }
  function finish(state) {
    if (!state.started || state.closed) return;
    const pcm = Buffer.concat(state.chunks, state.bytes);
    const stream = state.stream, endedAt = state.lastSpeech, priorityOnly = state.priorityOnly;
    const valid = state.voiced >= 16000 && pcm.length >= 16000; // >= 0.5 s de voz local a 16 kHz PCM16
    reset(state);
    if (!valid || stopped || !eligible(state.userId) || inflight.size >= maxPending || (createStreaming && !stream)) { closeStream(stream); return; }
    const job = { userId: state.userId, abort: new AbortController() };
    inflight.add(job);
    const abort = () => closeStream(stream); job.abort.signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => onUtterance({ userId: state.userId, pcm, stream, endedAt, priorityOnly, signal: job.abort.signal }))
      .catch(error => { if (!job.abort.signal.aborted && !stopped) onError(error); })
      .finally(() => { job.abort.signal.removeEventListener('abort', abort); closeStream(stream); inflight.delete(job); });
  }
  function subscribe(userId) {
    if (stopped || users.has(userId) || !eligible(userId) || users.size >= maxUsers) return;
    const previous = receiver.subscriptions?.get(userId);
    if (previous?.destroyed) { previous.once('close', () => subscribe(userId)); return; }
    let state;
    try {
      const input = receiver.subscribe(userId, { end: { behavior: api.EndBehaviorType.Manual } });
      const decoder = decoderFactory();
      state = { userId, input, decoder, pending: Buffer.alloc(0), closed: false };
      reset(state); users.set(userId, state);
      const fail = error => { if (!state.closed) { cancel(userId); onError(error); } };
      input.on('error', fail); decoder.on('error', fail);
      decoder.on('end', () => { finish(state); cancel(userId); });
      input.on('close', () => { if (!state.closed) { finish(state); cancel(userId); } });
      decoder.on('data', chunk => {
        if (state.closed) return;
        if (!eligible(userId) || !acceptAudio(userId)) { closeStream(state.stream); reset(state); state.pending = Buffer.alloc(0); return; }
        try {
          state.vad ||= vadFactory();
          state.pending = Buffer.concat([state.pending, chunk]);
          const bytes = state.vad.frameBytes || 1024;
          while (state.pending.length >= bytes && !state.closed) {
            const frame = Buffer.from(state.pending.subarray(0, bytes)); state.pending = state.pending.subarray(bytes);
            const speech = state.vad.process(frame);
            if (!state.started) {
              state.pre = Buffer.concat([state.pre, frame]).subarray(-6400);
              if (!speech) continue;
              state.started = true; state.chunks.push(state.pre); state.bytes = state.pre.length; state.pre = Buffer.alloc(0);
            } else { state.chunks.push(frame); state.bytes += frame.length; if (state.stream) state.stream.write(frame); }
            state.priorityOnly ||= isPlayback();
            if (speech) { state.voiced += frame.length; state.lastSpeech = now(); }
            audioBuffers.set(userId, state.chunks);
            if (state.voiced >= 16000 && !state.stream && createStreaming && streams.size < maxPending && inflight.size < maxPending) {
              state.stream = createStreaming({ onPartial: text => onPartial(userId, text) });
              streams.add(state.stream);
              state.stream.write(Buffer.concat(state.chunks, state.bytes));
            }
            clearTimer(state.timer);
            state.timer = setTimer(() => finish(state), Math.max(1, endpointMs - (now() - state.lastSpeech)));
            state.timer?.unref?.();
            if (state.bytes >= 12 * 32000) finish(state);
          }
        } catch (error) { fail(error); }
      });
      input.pipe(decoder);
    } catch (error) { if (state) cancel(userId); onError(error); }
  }
  receiver.speaking.on('start', subscribe);
  function stop() {
    stopped = true; receiver.speaking.removeListener('start', subscribe);
    for (const id of [...users.keys()]) cancel(id);
    for (const job of inflight) job.abort.abort();
  }
  return { subscribe, cancel, stop, audioBuffers, users };
}
module.exports = { createAudioMixerManager };
