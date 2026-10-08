// Reservas persistidas ANTES de llamar al proveedor; fallos también cuentan.
function createUsageBudget({ store, now = Date.now, dailyRequests = 100, dailyTokens = 100000, dailyAudio = 1200 } = {}) {
  let entries, queue = Promise.resolve();
  function reserve({ tokens = 0, audio = 0 } = {}) {
    const task = queue.then(async () => {
      if (!store) throw Object.assign(new Error('Configura TARS_STATE_CHANNEL_ID para guardar el presupuesto.'), { code: 'AI_BUDGET' });
      if (!entries) {
        const raw = await store.read();
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed) || parsed.some(e => !Number.isFinite(e.time) || !Number.isFinite(e.tokens) || !Number.isFinite(e.audio) || e.tokens < 0 || e.audio < 0)) throw new Error('Registro de cuota inválido');
        entries = parsed;
      }
      const time = now();
      entries = entries.filter(e => time - e.time < 86400000);
      const total = entries.reduce((a, e) => ({ tokens: a.tokens + e.tokens, audio: a.audio + e.audio }), { tokens: 0, audio: 0 });
      if (entries.length >= dailyRequests || total.tokens + tokens > dailyTokens || total.audio + audio > dailyAudio || entries.filter(e => time - e.time < 60000).length >= 6) {
        throw Object.assign(new Error('Presupuesto gratuito reservado agotado. Espera antes de volver a preguntar.'), { code: 'AI_BUDGET' });
      }
      const next = [...entries, { time, tokens, audio }];
      await store.write(JSON.stringify(next));
      entries = next;
    });
    const safe = task.catch(error => {
      if (error.code === 'AI_BUDGET') throw error;
      throw Object.assign(new Error('No puedo verificar el presupuesto. Consultas suspendidas.'), { code: 'AI_BUDGET' });
    });
    queue = safe.catch(() => {});
    return safe;
  }
  return { reserve };
}
module.exports = { createUsageBudget };
