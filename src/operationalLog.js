const { AsyncLocalStorage } = require('node:async_hooks');

function createOperationalLog(client, { env = process.env, maxPending = 100, intervalMs = 1100,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), diagnostic = message => console.warn(message) } = {}) {
  const context = new AsyncLocalStorage();
  let tail = Promise.resolve(), pending = 0, overflow = false;
  const secrets = Object.entries(env).filter(([key, value]) => /TOKEN|KEY|SECRET|PASSWORD/.test(key) && value?.length >= 4).map(([, value]) => value);
  function clean(value) {
    let text = String(value ?? '');
    for (const secret of secrets) text = text.split(secret).join('[redactado]');
    return text.replace(/Bearer\s+\S+/gi, 'Bearer [redactado]').replace(/https?:\/\/\S+/g, '[URL omitida]').slice(0, 350);
  }
  async function resolve(data) {
    let channel;
    if (env.LOG_CHANNEL_ID) channel = client.channels.cache?.get(env.LOG_CHANNEL_ID) || await client.channels.fetch(env.LOG_CHANNEL_ID);
    else {
      const guilds = data.servidor_id ? [client.guilds.cache.get(data.servidor_id)].filter(Boolean) : [...client.guilds.cache.values()];
      const candidates = [];
      for (const guild of guilds) {
        let found = [...guild.channels.cache.values()].filter(c => c?.name === 'logs-tars' && c.isTextBased());
        if (!found.length) found = [...(await guild.channels.fetch()).values()].filter(c => c?.name === 'logs-tars' && c.isTextBased());
        candidates.push(...found);
      }
      if (candidates.length !== 1) throw Error('Sin LOG_CHANNEL_ID: debe existir un único canal logs-tars en el servidor del evento.');
      channel = candidates[0];
    }
    if (!channel?.isTextBased() || typeof channel.send !== 'function') throw Error('Canal de logs inexistente o no admite mensajes.');
    const me = channel.guild?.members.me || await channel.guild?.members.fetchMe();
    const permissions = channel.permissionsFor?.(me);
    const sendPermission = channel.isThread?.() ? 'SendMessagesInThreads' : 'SendMessages';
    if (permissions && !permissions.has(['ViewChannel', sendPermission])) throw Error('Faltan permisos efectivos Ver canal / Enviar mensajes en logs.');
    return channel;
  }
  function sendLog(event, details = {}) {
    if (pending >= maxPending) {
      if (!overflow) diagnostic('[logs] Cola llena: registros omitidos hasta recuperar capacidad.');
      overflow = true; return Promise.resolve(false);
    }
    pending++;
    const data = { ...context.getStore(), resultado: 'registrado', ...details };
    const timestamp = Date.now();
    const nonce = require('node:crypto').randomBytes(12).toString('hex');
    const task = tail.then(async () => {
      const content = await require('./logFormat').formatOperational(client, event, data, clean, timestamp);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const channel = await resolve(data);
          await channel.send({ content, nonce, enforceNonce: true, allowedMentions: { parse: [] } });
          return true;
        } catch (error) {
          // Errores de red ambiguos no se reenvían: Discord podría haber aceptado el mensaje.
          const transient = error.status === 429 || error.status >= 500;
          if (!transient || attempt === 2) {
            diagnostic(`[logs] ${clean(event)}: ${clean(error.code || '')} ${clean(error.message)}; registro no enviado.`);
            return false;
          }
          const delay = Math.max(1000, Number(error.retry_after || 0) * 1000, 1000 * 2 ** attempt);
          if (delay > 60000) { diagnostic(`[logs] ${clean(event)}: espera REST demasiado larga; registro omitido sin reintento anticipado.`); return false; }
          await sleep(delay);
        }
      }
    }).finally(async () => { await sleep(intervalMs); pending--; overflow = false; });
    tail = task.catch(() => {});
    return task;
  }
  sendLog.withContext = (ctx, fn) => context.run({ servidor_id: ctx.guild?.id, canal_id: ctx.channel?.id, usuario_id: ctx.user?.id }, fn);
  sendLog.flush = () => tail;
  return sendLog;
}
module.exports = { createOperationalLog };
