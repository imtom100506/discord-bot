function createDeepgramStream({ key, budget, signal, onPartial = () => {}, WebSocket = require('ws'), timeoutMs = 15000, finishTimeoutMs = 3000 }) {
  if (!key) throw Error('Falta DEEPGRAM_API_KEY.');
  let socket, pending = [], bytes = 0, finishing = false, completed = false, timer, finishTimer;
  const finals = new Map();
  let resolve, reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  // La recepción puede fallar antes de que el hablante termine.
  void result.catch(() => {});
  function cleanup() {
    clearTimeout(timer); clearTimeout(finishTimer); signal?.removeEventListener('abort', abort);
    pending = [];
    if (socket?.readyState === 1) socket.close();
    else socket?.terminate();
  }
  function done(error) {
    if (completed) return;
    completed = true; cleanup();
    if (error) reject(error); else resolve([...finals.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join(' ').trim().slice(0, 800));
  }
  const abort = () => done(Object.assign(Error('Transcripción cancelada'), { name: 'AbortError' }));
  function send(data) {
    if (socket.bufferedAmount > 512000) throw Error('STT no consume el audio a tiempo.');
    socket.send(data);
  }
  function endInput() {
    send(JSON.stringify({ type: 'CloseStream' }));
    finishTimer = setTimeout(() => done(Error('STT no confirmó el texto final.')), finishTimeoutMs);
    finishTimer.unref?.();
  }
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => done(Error('Tiempo de STT excedido.')), timeoutMs); timer.unref?.();
  Promise.resolve().then(async () => {
    if (completed) return;
    signal?.throwIfAborted();
    // Reservar la duración máxima ANTES de abrir la conexión; también se cobran fallos.
    await budget.reserve({ audio: 12 });
    signal?.throwIfAborted();
    if (completed) return;
    const query = new URLSearchParams({ model: 'nova-3', language: 'es', encoding: 'linear16', sample_rate: '16000', channels: '1', interim_results: 'true', punctuate: 'true', endpointing: 'false' });
    socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, { headers: { Authorization: `Token ${key}` }, handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
    socket.on('open', () => {
      try { for (const chunk of pending) send(chunk); pending = []; if (finishing) endInput(); }
      catch (error) { done(error); }
    });
    socket.on('message', data => {
      if (completed) return;
      try {
        const event = JSON.parse(String(data));
        if (event.type === 'Error') throw Error('STT rechazó la solicitud.');
        if (event.type === 'Results') {
          const text = event.channel?.alternatives?.[0]?.transcript || '';
          if (event.is_final && text) finals.set(Number(event.start) || 0, text);
          if (text) onPartial([...finals.values(), ...(event.is_final ? [] : [text])].join(' ').slice(0, 800));
        }
        if (event.type === 'Metadata' && finishing) done();
      } catch (error) { done(error); }
    });
    socket.on('error', () => done(Error('Conexión STT fallida.')));
    socket.on('close', code => {
      if (finishing && code === 1000) done(); else done(Error('STT cerrado antes de finalizar.'));
    });
  }).catch(done);
  return {
    write(chunk) {
      if (completed || finishing) return;
      bytes += chunk.length;
      if (bytes > 12 * 32000 + 1024) return done(Error('Audio STT demasiado largo.'));
      try { if (socket?.readyState === 1) send(chunk); else pending.push(Buffer.from(chunk)); }
      catch (error) { done(error); }
    },
    finish() { if (!finishing && !completed) { finishing = true; try { if (socket?.readyState === 1) endInput(); } catch (error) { done(error); } } return result; },
    cancel: abort,
  };
}
module.exports = { createDeepgramStream };
