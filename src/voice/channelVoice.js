const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { createAudioMixerManager } = require('./audioMixerManager');
const { createSileroVadFactory } = require('./sileroVad');
const { createContextManager } = require('../optimization/contextManager');
const { createLowLatencyPipeline, classify } = require('../optimization/lowLatencyPipeline.ts');
const { BoundedMap } = require('../boundedMap');
const { speechParts } = require('../voiceProfile');
const IDLE_MS = 5 * 60 * 1000;

function createChannelVoice({ client, askAI, audio, recordConversation = () => {}, enabled = false, api, decoderFactory,
  vadFactory = createSileroVadFactory(), memory = createContextManager(), tools = {}, env = process.env,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let session, joining = false;
  const tell = async (s, text) => {
    for (const content of require('../commandUtils').splitResponse(text)) {
      await s.channel.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
    }
  };
  function leave(s = session) {
    if (!s || s.closed) return;
    s.closed = true; s.abort.abort(); s.mixer?.stop(); clearTimer(s.idleTimer);
    s.player.stop(true); s.resource?.playStream?.destroy(); s.connection.destroy(); audio.close?.();
    s.pipeline?.clear(s.key); s.buttons.clear();
    if (session === s) session = undefined;
  }
  function schedule(s) {
    clearTimer(s.idleTimer);
    s.idleTimer = setTimer(() => {
      if (now() - s.lastCall >= IDLE_MS) { void tell(s, 'Me retiro tras 5 minutos sin llamados.'); leave(s); }
      else schedule(s);
    }, Math.max(1, IDLE_MS - (now() - s.lastCall)));
    s.idleTimer?.unref?.();
  }
  const save = () => { void memory.save().catch(() => console.warn('[voz:memoria] No se pudo persistir la memoria.')); };
  async function play(s, text, signal, started) {
    signal.throwIfAborted();
    if (s.closed || s.muted || !text) return;
    // TTS por frases: no se corta una respuesta larga en el límite del sintetizador.
    const parts = speechParts(text);
    for (const part of parts) {
      signal.throwIfAborted();
      let wav;
      try { wav = await audio.synthesize(part, signal); }
      catch (error) {
        signal.throwIfAborted();
        if (!s.closed) await tell(s, text);
        console.warn('[voz:tts] Respuesta entregada por texto; no se cambia la voz.');
        return;
      }
      signal.throwIfAborted(); if (s.closed || s.muted) return;
      s.resource = api.createAudioResource(Readable.from([wav]), { inputType: api.StreamType.Arbitrary, inlineVolume: true });
      s.resource.volume?.setVolume(s.volume);
      s.speaking = true;
      const abort = () => s.player.stop(true);
      signal.addEventListener('abort', abort, { once: true });
      try {
        s.player.play(s.resource);
        await api.entersState(s.player, api.AudioPlayerStatus.Playing, 10000);
        if (started && !started.logged) {
          started.logged = true;
          const elapsed = now() - started.endedAt;
          console.info('[voz:latencia]', JSON.stringify({ fin_a_reproduccion_ms: elapsed, objetivo_ms: 800, cumple: elapsed < 800 }));
        }
        await api.entersState(s.player, api.AudioPlayerStatus.Idle, 45000);
      } finally {
        signal.removeEventListener('abort', abort); s.speaking = false; s.echoUntil = now() + 200;
        s.resource?.playStream?.destroy(); s.resource = undefined;
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
      eligible: id => !s.closed && s.listening && now() >= s.blockedUntil && id !== client.user.id && !s.excluded.has(id) &&
        s.voiceChannel.members.has(id) && !s.voiceChannel.members.get(id).user.bot,
      acceptAudio: () => env.TARS_ALLOW_BARGE_IN === 'true' || (!s.speaking && now() >= s.echoUntil),
      createStreaming: audio.createStreaming ? options => audio.createStreaming({ ...options, signal: s.abort.signal }) : undefined,
      onPartial: (id, text) => s.pipeline.prepare(s.key, id, text),
      onUtterance: item => receive(s, item),
      onError: error => failure(s, error),
    });
    for (const id of s.voiceChannel.members.keys()) s.mixer.subscribe(id);
  }
  function failure(s, error) {
    if (s.closed || error.name === 'AbortError') return;
    console.warn('[voz:error]', JSON.stringify({ code: error.code || 'VOICE_PIPELINE', name: error.name }));
    if (error.code === 'AI_BUDGET') { s.blockedUntil = now() + (error.retryAfterMs || 30000); s.pauseMessage = error.message; }
    if (now() >= s.nextError) {
      s.nextError = now() + 10000;
      void tell(s, error.code === 'AI_BUDGET' ? error.message : 'No pude completar la respuesta de voz. Usa /escuchar para reintentar.');
    }
  }
  async function execute(s, intent) {
    switch (intent) {
      case 'stop': s.listening = false; s.mixer.stop(); s.connection.rejoin?.({ selfDeaf: true }); void tell(s, 'Escucha pausada. /escuchar vuelve a activarla.'); return '';
      case 'leave': leave(s); return '';
      case 'mute': s.muted = true; s.player.stop(true); void tell(s, 'Voz de TARS silenciada. Di “TARS desmuteate” o usa /escuchar.'); return '';
      case 'unmute': s.muted = false; return 'Voz activada.';
      case 'repeat': return s.lastReply || 'Todavía no he respondido.';
      case 'volume_up': s.volume = Math.min(2, s.volume + 0.2); s.resource?.volume?.setVolume(s.volume); return 'Volumen subido.';
      case 'volume_down': s.volume = Math.max(0.2, s.volume - 0.2); s.resource?.volume?.setVolume(s.volume); return 'Volumen bajado.';
      case 'ping': return 'En línea.';
      case 'help': return 'Puedes pedirme que repita, cambie el volumen o deje de escuchar. Usa privacidad en el chat para excluir tu voz.';
      case 'moderation_help': return 'Para moderar usuarios usa los comandos escritos existentes, con una mención explícita. Verificaré tus permisos allí.';
      default: return 'Control no disponible.';
    }
  }
  async function receive(s, { userId, pcm, stream, endedAt, signal: captureSignal }) {
    const signal = AbortSignal.any([s.abort.signal, s.contextAbort.signal, captureSignal]);
    signal.throwIfAborted();
    const text = stream ? await stream.finish() : await audio.transcribe(pcm, signal);
    signal.throwIfAborted();
    if (!text || s.excluded.has(userId) || !s.listening) return;
    const member = s.voiceChannel.members.get(userId);
    if (!member || member.user.bot) return;
    const name = member.displayName || member.user.username || userId;
    const intent = classify(text);
    const addressed = now() < (s.manual.get(userId) || 0) || (s.followupUser === userId && now() < s.followupUntil);
    s.manual.delete(userId);
    const shouldRespond = addressed || env.TARS_WAKE_REQUIRED === 'false' || intent.wake || intent.direct;
    if (shouldRespond) { s.lastCall = now(); schedule(s); }
    // Los controles interrumpen inmediatamente aunque haya respuestas en cola.
    if (shouldRespond && intent.kind === 'command' && ['stop', 'leave', 'mute', 'unmute', 'volume_up', 'volume_down'].includes(intent.intent)) {
      const reply = await execute(s, intent.intent);
      if (reply && !s.closed) await queueSpeech(s, reply, signal, { endedAt });
      return;
    }
    if (s.pending >= 8) throw Object.assign(Error('Cola de voz llena'), { code: 'AI_BUSY' });
    const epoch = s.epoch;
    s.pending++;
    const job = s.turns.then(async () => {
      signal.throwIfAborted();
      if (epoch !== s.epoch || s.excluded.has(userId) || !s.listening || !s.voiceChannel.members.has(userId) || now() - endedAt > 15000) return;
      const result = await s.pipeline.run({ key: s.key, userId, name, text, signal, addressed });
      if (result?.reply) await queueSpeech(s, result.reply, signal, { endedAt });
      signal.throwIfAborted();
      if (epoch !== s.epoch || s.excluded.has(userId)) return;
      const tagged = memory.add(s.key, { userId, name, role: 'user', text });
      if (env.TARS_VOICE_LOG_ENABLED === 'true') void recordConversation({ guildId: s.voiceChannel.guild.id, channelId: s.voiceChannel.id, userId, role: 'user', text: tagged });
      if (result?.reply) {
        s.lastReply = result.reply; s.followupUser = userId; s.followupUntil = now() + 8000;
        memory.add(s.key, { userId, name: 'TARS', role: 'assistant', text: result.reply });
        if (env.TARS_VOICE_LOG_ENABLED === 'true') void recordConversation({ guildId: s.voiceChannel.guild.id, channelId: s.voiceChannel.id, userId, role: 'assistant', text: result.reply });
        if (result.suggestions?.length) {
          const token = randomUUID(); s.buttons.set(token, { userId, text, expires: now() + 60000 });
          void s.channel.send({ content: 'Puedes continuar:', allowedMentions: { parse: [] }, components: [{ type: 1, components: result.suggestions.map((label, index) => ({ type: 2, style: 2, label, custom_id: `tars_followup:${token}:${index}` })) }] }).catch(() => {});
        }
      }
      save();
    });
    s.turns = job.catch(() => {}).finally(() => { s.pending--; });
    return job;
  }
  async function handle(ctx, command, argument = 'estado') {
    if (command === 'privacidad' && argument === 'borrar' && !session) { await forget(ctx.user.id); return ctx.reply('Tu memoria local fue borrada. No se eliminaron registros externos.'); }
    if (command === 'privacidad' && (!ctx.guild || !session)) return ctx.reply('TARS recibe voz de todo el canal mientras está conectado. PCM temporal, STT externo, contexto local y memoria en channelMemory.json. /privacidad excluir evita procesar tu voz; incluir revierte la exclusión; borrar elimina tu memoria local. No elimina registros ya enviados a Discord o proveedores.');
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
          excluded: new Set(memory.excluded(key)), manual: new BoundedMap(64), buttons: new BoundedMap(20) };
        session = s;
        s.player.on('error', error => { failure(s, error); leave(s); }); connection.on('error', error => { failure(s, error); leave(s); });
        connection.on('stateChange', (_, state) => { if (state.status === api.VoiceConnectionStatus.Disconnected) leave(s); });
        await Promise.all([audio.check(), api.entersState(connection, api.VoiceConnectionStatus.Ready, 15000)]);
        s.abort.signal.throwIfAborted(); connection.subscribe(s.player);
        s.pipeline = createLowLatencyPipeline({ askAI, memory, tools, now, wakeRequired: env.TARS_WAKE_REQUIRED !== 'false', humor: Math.max(0, Math.min(100, Number(env.TARS_HUMOR ?? 75) || 0)), execute: intent => execute(s, intent) });
        await ctx.reply('En línea. Escuchando a todo el canal. Voz procesada por STT externo; usa /privacidad para ver detalles o excluirte. Di TARS, pregunta directamente o usa /escuchar.');
        await play(s, 'Escuchando a todo el canal', s.abort.signal);
        s.echoUntil = 0; startMixer(s); schedule(s);
      } catch (error) { leave(s); throw error; }
      finally { joining = false; }
      return;
    }
    const s = session;
    if (!s || s.voiceChannel.id !== channel.id) return ctx.reply('Debes estar en mi canal. Usa /entrar si todavía no estoy conectado.');
    if (command === 'privacidad') {
      const action = String(argument || 'estado').toLowerCase().trim();
      if (action === 'excluir') { s.excluded.add(ctx.user.id); s.mixer?.cancel(ctx.user.id); await memory.exclude(s.key, ctx.user.id, true); await forget(ctx.user.id); return ctx.reply('Tu voz queda excluida en este canal y se borró tu memoria local. La exclusión persiste en disco.'); }
      if (action === 'incluir') { await memory.exclude(s.key, ctx.user.id, false); s.excluded.delete(ctx.user.id); s.mixer?.subscribe(ctx.user.id); return ctx.reply('Tu voz vuelve a incluirse.'); }
      if (action === 'borrar') { await forget(ctx.user.id); return ctx.reply('Memoria local borrada. Los registros ya enviados a Discord o proveedores no se eliminan. Usa excluir para dejar de procesar tu voz.'); }
      return ctx.reply(`Escucha global ${s.listening ? 'activa' : 'pausada'}. Tu voz: ${s.excluded.has(ctx.user.id) ? 'excluida' : 'incluida'}. STT: ${audio.createStreaming ? 'Deepgram streaming' : 'Groq Whisper por lotes'}. PCM solo en RAM; resumen + 6 mensajes recientes en RAM; nombres, gustos y recuerdos explícitos en channelMemory.json. Logs Discord: ${env.TARS_VOICE_LOG_ENABLED === 'true' ? 'activados' : 'desactivados'}. /privacidad excluir | incluir | borrar.`);
    }
    if (command === 'salir') { leave(s); return ctx.reply('Desconectado del canal de voz.'); }
    if (s.excluded.has(ctx.user.id)) return ctx.reply('Tu voz está excluida. Usa /privacidad incluir primero.');
    if (now() < s.blockedUntil) return ctx.reply(s.pauseMessage || 'Espera a que se restablezca la cuota de voz.');
    if (!s.listening) { s.listening = true; s.connection.rejoin?.({ selfDeaf: false }); startMixer(s); }
    s.muted = false; s.manual.set(ctx.user.id, now() + 12000); s.mixer.subscribe(ctx.user.id); s.lastCall = now(); schedule(s);
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
      if (oldState.channelId !== newState.channelId && newState.id !== client.user.id) void tell(s, 'Escuchando a todo el canal. Quien se acaba de unir puede usar /privacidad para excluir su voz.');
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
    } catch { await interaction.editReply({ content: 'No pude completar la sugerencia.', allowedMentions: { parse: [] } }); }
    return true;
  }
  return { handle, leave, onVoiceState, forget, handleSuggestion };
}
module.exports = { createChannelVoice };
