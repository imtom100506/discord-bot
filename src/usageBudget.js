// Se persiste antes de llamar al proveedor. Ventanas móviles, sin reinicios de cuota.
function createUsageBudget({ store, now = Date.now, dailyRequests = 500, dailyTokens = 100000,
  dailyAudio = 3600, minuteRequests = 6 } = {}) {
  let entries, queue = Promise.resolve();
  function reserve({ tokens = 0, audio = 0 } = {}) {
    const task = queue.then(async () => {
      if (!store) throw new Error('Falta almacenamiento de cuota');
      if (!Number.isFinite(tokens) || !Number.isFinite(audio) || tokens < 0 || audio < 0) throw new Error('Reserva inválida');
      if (!entries) {
        const raw = await store.read();
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed) || parsed.some(e => !Number.isFinite(e.time) || !Number.isFinite(e.tokens) || !Number.isFinite(e.audio) || e.tokens < 0 || e.audio < 0)) throw new Error('Registro de cuota inválido');
        entries = parsed;
      }
      const time = now();
      entries = entries.filter(e => time - e.time < 86400000);
      const minute = entries.filter(e => time - e.time < 60000);
      const limits = [
        ['requests_day', entries, () => 1, 1, dailyRequests, 86400000],
        ['tokens_day', entries, e => e.tokens, tokens, dailyTokens, 86400000],
        ['audio_day', entries, e => e.audio, audio, dailyAudio, 86400000],
        // Compatible con registros anteriores: audio > 0 identifica transcripción.
        ['requests_minute', minute.filter(e => (e.audio > 0) === (audio > 0)), () => 1, 1, minuteRequests, 60000],
      ];
      let blocked;
      for (const [reason, records, weight, requested, limit, window] of limits) {
        let excess = records.reduce((sum, e) => sum + weight(e), requested) - limit;
        if (excess <= 0) continue;
        let retryAfterMs = window;
        for (const entry of [...records].sort((a, b) => a.time - b.time)) {
          excess -= weight(entry);
          if (excess <= 0) { retryAfterMs = Math.max(1, entry.time + window - time); break; }
        }
        if (!blocked || retryAfterMs > blocked.retryAfterMs) blocked = { reason, retryAfterMs };
      }
      if (blocked) {
        const message = blocked.retryAfterMs <= 60000
          ? 'Dame un momento; podremos seguir en menos de un minuto.'
          : 'Necesito una pausa más larga. Podemos retomar más tarde.';
        throw Object.assign(new Error(message), { code: 'AI_BUDGET', ...blocked });
      }
      const next = [...entries, { time, tokens, audio }];
      await store.write(JSON.stringify(next));
      entries = next;
    });
    const safe = task.catch(error => {
      if (error.code === 'AI_BUDGET') throw error;
      throw Object.assign(new Error('No puedo responder ahora. Inténtalo en un momento.'), { code: 'AI_BUDGET', reason: 'storage', retryAfterMs: 30000 });
    });
    queue = safe.catch(() => {});
    return safe;
  }
  return { reserve };
}
module.exports = { createUsageBudget };
