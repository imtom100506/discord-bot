const { voiceControl, startCountdown } = require('../voiceControl');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { createAudioMixerManager } = require('./audioMixerManager');
const { createSileroVadFactory } = require('./sileroVad');
const { createContextManager } = require('../optimization/contextManager');
const { createLowLatencyPipeline, classify } = require('../optimization/lowLatencyPipeline.ts');
const { BoundedMap } = require('../boundedMap');
const { speechParts } = require('../voiceProfile');
const IDLE_MS = 5 * 60 * 1000;

function createChannelVoice({ client, askAI, audio, recordConversation = () => {}, sendLog = () => {}, enabled = false, api, decoderFactory,
  vadFactory = createSileroVadFactory(), memory = createContextManager(), tools = {}, env = process.env,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let session, joining = false;
  const tell = async (s, text) => {
    for (const content of require('../commandUtils').splitResponse(text)) {
      await s.channel.send({ content, allowedMentions: { parse: [] } }).catch(error => log(s, 'voz_chat_error', { error: error.message }));
    }
  };
  const log = (s, event, data = {}) => sendLog(event, { servidor_id: s.voiceChannel.guild.id, canal_id: s.voiceChannel.id, canal_nombre: s.voiceChannel.name, ...data });
  function leave(s = session, reason = 'salida') {
    if (!s || s.closed) return;
    s.closed = true; clearTimer(s.countdownTimer); s.contextAbort.abort(); s.abort.abort(); s.mixer?.stop(); clearTimer(s.idleTimer);
    s.player.stop(true); s.resource?.playStream?.destroy(); s.connection.destroy(); audio.close?.();
    s.subscription?.unsubscribe(); s.connection.removeAllListeners('stateChange');
    s.pipeline?.clear(s.key); s.buttons.clear(); s.manual.clear(); s.latest.clear();
    log(s, 'voz_desconexion', { motivo: reason, usuario_id: s.controlUser, resultado: 'desconectado' });
    if (session === s) session = undefined;
  }
  function schedule(s) {
    clearTimer(s.idleTimer);
    s.idleTimer = setTimer(() => {
      if (s.closed || s.countdown) return;
      if (now() - s.lastCall >= IDLE_MS) { void tell(s, 'Me retiro tras 5 minutos sin llamados.'); leave(s); }
      else schedule(s);
    }, Math.max(1, IDLE_MS - (now() - s.lastCall)));
    s.idleTimer?.unref?.();
  }
  const save = s => { void memory.save().catch(error => log(s, 'voz_memoria_error', { error: error.message })); };
  async function play(s, text, signal, started) {
    signal.throwIfAborted();
    if (s.closed || s.countdown || s.muted || !text) return;
    // TTS por frases: no se corta una respuesta larga en el límite del sintetizador.
    const tooLate = () => started && now() - started.endedAt > 15000;
    if (tooLate()) { await tell(s, text); return; }
    const parts = speechParts(text);
    for (const part of parts) {
      signal.throwIfAborted();
      let wav; const synthesisStarted = now();
      try { wav = await audio.synthesize(part, signal); }
      catch (error) {
        signal.throwIfAborted();
        if (!s.closed) await tell(s, text);
        log(s, 'voz_tts_error', { error: error.message, resultado: 'entregado por texto' });
        return;
      }
      signal.throwIfAborted(); if (s.closed || s.countdown || s.muted) return;
      if (tooLate()) {
        await tell(s, text);
        log(s, 'voz_respuesta_texto', { motivo: 'síntesis tardía; audio omitido', demora_ms: now() - started.endedAt });
        return;
      }
      s.resource = api.createAudioResource(Readable.from([wav]), { inputType: api.StreamType.Arbitrary, inlineVolume: true });
      s.resource.volume?.setVolume(s.volume);
      const resource = s.resource;
      s.speaking = true;
      const abort = () => s.player.stop(true);
      signal.addEventListener('abort', abort, { once: true });
      try {
        s.player.play(s.resource);
        await api.entersState(s.player, api.AudioPlayerStatus.Playing, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
        if (started && !started.logged) {
          started.logged = true;
          const elapsed = now() - started.endedAt;
          console.info('[voz:latencia]', JSON.stringify({ fin_a_reproduccion_ms: elapsed, stt_ms: started.sttMs, cola_ms: started.queueMs, modelo_ms: started.modelMs, sintesis_ms: now() - synthesisStarted, objetivo_ms: 800, cumple: elapsed < 800 }));
        }
        await api.entersState(s.player, api.AudioPlayerStatus.Idle, AbortSignal.any([signal, AbortSignal.timeout(45000)]));
      } finally {
        signal.removeEventListener('abort', abort); s.speaking = false; s.echoUntil = now() + 200;
        resource.playStream?.destroy(); if (s.resource === resource) s.resource = undefined;
      }
    }
  }
  function queueSpeech(s, text, signal, metric) {
    // Cola pequeña y serializada para respuestas y controles del canal.
    if (s.speechPending >= 16) throw Error('Cola de voz llena.');
    s.speechPending++;
    const job = s.speechQueue.then(() => play(s, text, signal, metric));
    s.speechQueue = job.catch(() => {}).finally(() => { s.speechPending--; });
    return job;
  }
  function startMixer(s) {
    s.mixer = createAudioMixerManager({ receiver: s.connection.receiver, api, decoderFactory, vadFactory, now, setTimer, clearTimer,
      endpointMs: Math.max(240, Math.min(1500, Number(env.TARS_VAD_ENDPOINT_MS) || 650)),
      eligible: id => !s.closed && s.listening && now() >= s.blockedUntil && id !== client.user.id && !s.excluded.has(id) &&
        s.voiceChannel.members.has(id) && !s.voiceChannel.members.get(id).user.bot,
      isPlayback: () => s.speaking,
      acceptAudio: () => true, // Las órdenes prioritarias necesitan recepción durante la reproducción.
      createStreaming: audio.createStreaming ? options => audio.createStreaming({ ...options, signal: s.abort.signal }) : undefined,
      onPartial: (id, text) => s.pipeline.prepare(s.key, id, text),
      onUtterance: item => receive(s, item),
      onError: error => failure(s, error),
    });
    for (const id of s.voiceChannel.members.keys()) s.mixer.subscribe(id);
  }
  function failure(s, error) {
    if (s.closed || error.name === 'AbortError') return;
    if (error.code === 'AI_BUDGET') {
      const until = now() + (error.retryAfterMs || 30000);
      if (error.scope === 'llm') s.modelBlockedUntil = Math.max(s.modelBlockedUntil || 0, until);
      else s.blockedUntil = Math.max(s.blockedUntil, until);
      s.pauseMessage = error.message;
      // Invalida respuestas anteriores sin cerrar STT cuando solo se agotó LLM.
      s.epoch++; s.contextAbort.abort(); s.contextAbort = new AbortController();
      s.latest.clear();
    }
    if (now() < s.nextError) return;
    log(s, 'voz_error', { codigo: error.code || 'VOICE_PIPELINE', error: error.message,
      limite: error.reason, servicio: error.scope, espera_segundos: error.retryAfterMs && Math.ceil(error.retryAfterMs / 1000) });
    if (now() >= s.nextError) {
      s.nextError = now() + Math.max(10000, error.retryAfterMs || 0);
      void tell(s, ['AI_BUDGET', 'VOICE_STALE'].includes(error.code) ? error.message : 'No pude completar la respuesta de voz. Usa /escuchar para reintentar.');
    }
  }
  async function execute(s, intent) {
    log(s, 'voz_control', { control: intent, resultado: 'procesado' });
    switch (intent) {
      case 'stop': s.listening = false; s.mixer.stop(); s.connection.rejoin?.({ selfDeaf: true }); void tell(s, 'Escucha pausada. /escuchar vuelve a activarla.'); return '';
      case 'leave': leave(s); return '';
      case 'mute': s.muted = true; s.player.stop(true); void tell(s, 'Voz de TARS silenciada. Di “TARS desmuteate” o usa /escuchar.'); return '';
      case 'unmute': s.muted = false; return 'Voz activada.';
      case 'repeat': return s.lastReply || 'Todavía no he respondido.';
      case 'volume_up': s.volume = Math.min(2, s.volume + 0.2); s.resource?.volume?.setVolume(s.volume); return 'Volumen subido.';
      case 'volume_down': s.volume = Math.max(0.2, s.volume - 0.2); s.resource?.volume?.setVolume(s.volume); return 'Volumen bajado.';
      case 'ping': return 'En línea.';
      case 'help': return 'Puedes pedirme que repita, cambie el volumen o deje de escuchar. Puedes pedirme que salga o active la autodestrucción.';
      case 'moderation_help': return 'Para moderar usuarios usa los comandos escritos existentes, con una mención explícita. Verificaré tus permisos allí.';
      default: return 'Control no disponible.';
    }
  }
  async function receive(s, { userId, pcm, stream, endedAt, priorityOnly, signal: captureSignal }) {
    const receivingDuringPlayback = priorityOnly || s.speaking, captureEpoch = s.epoch;
    const signal = AbortSignal.any([s.abort.signal, captureSignal]);
    signal.throwIfAborted();
    const sttStarted = now();
    const text = stream ? await stream.finish() : await audio.transcribe(pcm, signal);
    signal.throwIfAborted();
    if (!text || s.excluded.has(userId) || !s.listening) return;
    const member = s.voiceChannel.members.get(userId);
    if (!member || member.user.bot) return;
    const control = voiceControl(text);
    if (control) {
      s.controlUser = userId;
      if (control === 'leave') leave(s, 'solicitud_por_voz');
      else startCountdown(s, { audio, api, leave, setTimer, clearTimer,
        log: (event, data) => log(s, event, { usuario_id: userId, ...data }),
        cancel: () => { s.epoch++; s.contextAbort.abort(); s.player.stop(true); s.resource?.playStream?.destroy(); s.resource = undefined; s.pipeline.clear(s.key); s.buttons.clear(); } });
      return;
    }
    if (captureEpoch !== s.epoch || s.countdown || (receivingDuringPlayback && env.TARS_ALLOW_BARGE_IN !== 'true')) return;
    const turnSignal = AbortSignal.any([signal, s.contextAbort.signal]);
    const name = member.displayName || member.user.username || userId;
    const intent = classify(text);
    const addressed = now() < (s.manual.get(userId) || 0) || (s.followupUser === userId && now() < s.followupUntil);
    s.manual.delete(userId);
    const shouldRespond = addressed || env.TARS_WAKE_REQUIRED === 'false' || intent.wake || intent.direct;
    if (shouldRespond) { s.lastCall = now(); schedule(s); }
    // Los controles interrumpen inmediatamente aunque haya respuestas en cola.
    if (shouldRespond && intent.kind === 'command' && ['stop', 'leave', 'mute', 'unmute', 'volume_up', 'volume_down'].includes(intent.intent)) {
      const reply = await execute(s, intent.intent);
      if (reply && !s.closed) await queueSpeech(s, reply, turnSignal, { endedAt });
      return;
    }
    if (shouldRespond && intent.kind !== 'command' && now() < (s.modelBlockedUntil || 0)) return;
    if (s.pending >= 3) throw Object.assign(Error('Cola de voz llena'), { code: 'AI_BUSY' });
    const epoch = s.epoch, ticket = Symbol(), enqueuedAt = now(), sttMs = now() - sttStarted;
    s.latest.set(userId, ticket);
    s.pending++;
    const job = s.turns.then(async () => {
      const signal = turnSignal;
      signal.throwIfAborted();
      if (s.latest.get(userId) !== ticket) return;
      if (epoch !== s.epoch || s.excluded.has(userId) || !s.listening || !s.voiceChannel.members.has(userId)) return;
      if (now() - endedAt > 15000) {
        failure(s, Object.assign(Error('La pregunta quedó esperando demasiado. Vuelve a preguntarme; no reproduciré una respuesta atrasada.'), { code: 'VOICE_STALE' }));
        return;
      }
      const modelStarted = now();
      const result = await s.pipeline.run({ key: s.key, userId, name, text, signal, addressed });
      if (result?.reply) {
        if (now() - endedAt > 15000) {
          await tell(s, result.reply);
          log(s, 'voz_respuesta_texto', { usuario_id: userId, motivo: 'respuesta tardía; audio omitido', demora_ms: now() - endedAt });
        } else await queueSpeech(s, result.reply, signal, { endedAt, sttMs, queueMs: modelStarted - enqueuedAt, modelMs: now() - modelStarted });
      }
      signal.throwIfAborted();
      if (epoch !== s.epoch || s.excluded.has(userId)) return;
      const tagged = memory.add(s.key, { userId, name, role: 'user', text });
      if (env.TARS_VOICE_LOG_ENABLED === 'true') void recordConversation({ guildId: s.voiceChannel.guild.id, channelId: s.voiceChannel.id, userId, role: 'user', text: tagged });
      if (result?.reply) {
        log(s, 'voz_respuesta', { usuario_id: userId, resultado: 'completada' });
        s.lastReply = result.reply; s.followupUser = userId; s.followupUntil = now() + 8000;
        memory.add(s.key, { userId, name: 'TARS', role: 'assistant', text: result.reply });
        if (env.TARS_VOICE_LOG_ENABLED === 'true') void recordConversation({ guildId: s.voiceChannel.guild.id, channelId: s.voiceChannel.id, userId, role: 'assistant', text: result.reply });
        if (result.suggestions?.length) {
          const token = randomUUID(); s.buttons.set(token, { userId, text, expires: now() + 60000 });
          void s.channel.send({ content: 'Puedes continuar:', allowedMentions: { parse: [] }, components: [{ type: 1, components: result.suggestions.map((label, index) => ({ type: 2, style: 2, label, custom_id: `tars_followup:${token}:${index}` })) }] }).catch(() => {});
        }
      }
      save(s);
    });
    s.turns = job.catch(() => {}).finally(() => { s.pending--; if (s.latest.get(userId) === ticket) s.latest.delete(userId); });
    void job.catch(error => failure(s, error)); // Libera la ranura STT: las respuestas no bloquean nuevos controles.
  }
  async function handle(ctx, command) {
    if (!['entrar', 'escuchar', 'salir'].includes(command)) return;
    if (!enabled) return ctx.reply('La voz aún no está habilitada.');
    if (!ctx.guild) return ctx.reply('Usa este comando dentro de un servidor.');
    const member = ctx.guild.members.cache?.get(ctx.user.id) || await ctx.guild.members.fetch(ctx.user.id);
    const channel = member.voice.channel;
    if (!channel) return ctx.reply('Primero entra a un canal de voz.');
    if (command === 'entrar') {
      if (session || joining) return ctx.reply('Ya estoy conectado o conectándome. Atiendo un solo canal a la vez.');
      if (channel.type !== 2) return ctx.reply('Solo puedo entrar a canales de voz normales.');
      if (!channel.permissionsFor(ctx.guild.members.me)?.has(['ViewChannel', 'Connect', 'Speak'])) return ctx.reply('Necesito Ver canal, Conectar y Hablar en ese canal.');
      joining = true;
      let s;
      try {
        api ||= require('@discordjs/voice'); decoderFactory ||= require('../opusDecoder').createOpusDecoder;
        await memory.load(); vadFactory.check?.();
        const key = `${ctx.guild.id}:${channel.id}`;
        const connection = api.joinVoiceChannel({ channelId: channel.id, guildId: ctx.guild.id, adapterCreator: ctx.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
        s = { key, connection, voiceChannel: channel, channel: ctx.channel, player: api.createAudioPlayer(), abort: new AbortController(), contextAbort: new AbortController(),
          closed: false, listening: true, muted: false, speaking: false, echoUntil: 0, volume: 1, lastCall: now(),
          blockedUntil: 0, nextError: 0, pending: 0, speechPending: 0, epoch: 0, turns: Promise.resolve(), speechQueue: Promise.resolve(),
          latest: new Map(), excluded: new Set(memory.excluded(key)), manual: new BoundedMap(64), buttons: new BoundedMap(20) };
        session = s;
        s.player.on('error', error => { failure(s, error); if (!s.countdown) leave(s); }); connection.on('error', error => { failure(s, error); leave(s); });
        connection.on('stateChange', (_, state) => { if (state.status === api.VoiceConnectionStatus.Disconnected) leave(s); });
        await Promise.all([audio.check(), api.entersState(connection, api.VoiceConnectionStatus.Ready, 15000)]);
        s.abort.signal.throwIfAborted();
        void Promise.resolve(audio.warm?.()).catch(error => log(s, 'voz_preparacion_error', { error: error.message }));
        s.subscription = connection.subscribe(s.player);
        log(s, 'voz_conexion', { usuario_id: ctx.user.id, resultado: 'conectado' });
        s.pipeline = createLowLatencyPipeline({ askAI: (id, text, options) => askAI(id, text, { ...options, onProviderFailure: data => log(s, 'ia_proveedor_error', { usuario_id: id, ...data }) }), memory, tools, now, wakeRequired: env.TARS_WAKE_REQUIRED !== 'false', humor: Math.max(0, Math.min(100, Number(env.TARS_HUMOR ?? 75) || 0)), execute: intent => execute(s, intent) });
        await ctx.reply('En línea. Escuchando a todo el canal. Voz procesada por STT externo. /salir detiene la recepción y /reset borra tu memoria local. Di TARS, pregunta directamente o usa /escuchar.');
        startMixer(s);
        try { await play(s, 'Escuchando a todo el canal', s.contextAbort.signal); }
        catch (error) { if (!s.closed && !s.countdown) throw error; }
        if (!s.closed && !s.countdown) { s.echoUntil = 0; schedule(s); }
      } catch (error) { leave(s); throw error; }
      finally { joining = false; }
      return;
    }
    const s = session;
    if (!s || s.voiceChannel.id !== channel.id) return ctx.reply('Debes estar en mi canal. Usa /entrar si todavía no estoy conectado.');
    if (command === 'salir') { leave(s); return ctx.reply('Desconectado del canal de voz.'); }
    if (s.countdown) return ctx.reply('Cuenta regresiva en curso. /salir desconecta inmediatamente.');
    if (s.excluded.has(ctx.user.id)) return ctx.reply('Tu voz está excluida. La exclusión guardada sigue vigente.');
    if (now() < s.blockedUntil) return ctx.reply(`Transcripción en pausa. Reintenta en ${Math.ceil((s.blockedUntil - now()) / 1000)} segundos.`);
    if (!s.listening) { s.listening = true; s.connection.rejoin?.({ selfDeaf: false }); startMixer(s); }
    s.muted = false; s.manual.set(ctx.user.id, now() + 12000); s.mixer.subscribe(ctx.user.id); s.lastCall = now(); schedule(s);
    if (now() < (s.modelBlockedUntil || 0)) return ctx.reply(`Te escucho para controles de voz. Las respuestas de IA vuelven en ${Math.ceil((s.modelBlockedUntil - now()) / 1000)} segundos.`);
    return ctx.reply('Te escucho. Tu próxima intervención no necesita decir TARS.');
  }
  async function forget(userId) {
    const s = session;
    if (!s) { await memory.forgetEverywhere(userId); return; }
    s.epoch++; s.contextAbort.abort(); s.contextAbort = new AbortController();
    s.mixer?.cancel(userId); s.pipeline.clear(s.key); s.lastReply = ''; s.buttons.clear();
    await memory.forgetEverywhere(userId);
    if (!s.excluded.has(userId)) s.mixer?.subscribe(userId);
  }
  function onVoiceState(oldState, newState) {
    const s = session;
    if (!s || oldState.guild.id !== s.voiceChannel.guild.id) return;
    if (newState.id === client.user.id && newState.channelId !== s.voiceChannel.id) return leave(s);
    if (newState.channelId === s.voiceChannel.id) {
      s.mixer?.subscribe(newState.id);
      if (oldState.channelId !== newState.channelId && newState.id !== client.user.id) void tell(s, 'Escuchando a todo el canal. STT externo activo. /salir detiene la recepción; /reset borra tu memoria local.');
    } else s.mixer?.cancel(newState.id);
    if (![...s.voiceChannel.members.values()].some(m => !m.user.bot)) leave(s);
  }
  async function handleSuggestion(interaction) {
    if (!interaction.customId?.startsWith('tars_followup:')) return false;
    const [, token, index] = interaction.customId.split(':');
    const s = session, item = s?.buttons.get(token);
    await interaction.deferReply({ flags: 64 });
    if (!item || item.userId !== interaction.user.id || item.expires < now() || !s.voiceChannel.members.has(item.userId) || s.excluded.has(item.userId)) {
      await interaction.editReply({ content: 'Esta sugerencia venció o pertenece a otro usuario.', allowedMentions: { parse: [] } }); return true;
    }
    s.buttons.delete(token);
    try {
      const signal = AbortSignal.any([s.abort.signal, s.contextAbort.signal]);
      const result = await s.pipeline.run({ key: s.key, userId: item.userId, text: index === '0' ? 'resume lo que dijeron' : `busca ${item.text}`, signal, addressed: true });
      signal.throwIfAborted();
      await interaction.editReply({ content: result.reply || 'Sin resultados.', allowedMentions: { parse: [] } });
    } catch (error) { failure(s, error); await interaction.editReply({ content: 'No pude completar la sugerencia.', allowedMentions: { parse: [] } }); }
    return true;
  }
  return { handle, leave, onVoiceState, forget, handleSuggestion };
}
module.exports = { createChannelVoice };
