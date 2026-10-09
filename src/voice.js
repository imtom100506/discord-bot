const { Readable } = require('node:stream');
const { startWakeListener } = require('./wakeListener');
const IDLE_MS = 10 * 60 * 1000;
const MAX_AUDIO_BYTES = 12 * 32000;

function createVoice({ client, askAI, audio, enabled = false, api, decoderFactory, wakeFactory = null, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let session, joining = false;
  const load = () => {
    api ||= require('@discordjs/voice');
    decoderFactory ||= () => new (require('prism-media').opus.Decoder)({ rate: 16000, channels: 1, frameSize: 320 });
  };
  const tell = (s, text) => s.channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
  function leave(s = session) {
    if (!s || s.closed) return;
    s.closed = true;
    s.wake?.stop();
    wakeFactory?.dispose?.();
    clearTimer(s.idleTimer); clearTimer(s.captureTimer);
    s.abort.abort(); s.cancelCapture?.();
    s.player.stop(true); s.resource?.playStream.destroy();
    s.connection.destroy();
    if (session === s) session = undefined;
  }
  function schedule(s) {
    clearTimer(s.idleTimer);
    s.idleTimer = setTimer(() => {
      if (s.closed) return;
      if (s.fixedDeadline) {
        void tell(s, 'Terminó mi sesión de 10 minutos. Usa /entrar para invitarme otra vez.');
        return leave(s);
      }
      if (now() - s.lastCall < IDLE_MS) return schedule(s);
      if (s.busy) { s.expired = true; return; }
      void tell(s, 'Me retiro: pasaron 10 minutos sin llamados. Usa /entrar para invitarme otra vez.');
      leave(s);
    }, Math.max(1, IDLE_MS - (now() - s.lastCall)));
    s.idleTimer?.unref?.();
  }
  async function handle(ctx, command) {
    if (!enabled) return ctx.reply('La voz aún no está habilitada. Consulta VOICE-SETUP.md.');
    if (!ctx.guild) return ctx.reply('Usa este comando dentro de un servidor.');
    const member = await ctx.guild.members.fetch(ctx.user.id);
    const channel = member.voice.channel;
    if (!channel) return ctx.reply('Primero entra a un canal de voz.');
    if (command === 'entrar') {
      if (session || joining) return ctx.reply('Ya estoy conectado o conectándome. Atiendo un solo canal a la vez para ahorrar recursos.');
      if (channel.type !== 2) return ctx.reply('Solo puedo entrar a canales de voz normales.');
      const permissions = channel.permissionsFor(ctx.guild.members.me);
      if (!permissions?.has(['ViewChannel', 'Connect', 'Speak'])) return ctx.reply('Necesito Ver canal, Conectar y Hablar en ese canal.');
      joining = true;
      let s;
      try {
        await audio.check(); load();
        const connection = api.joinVoiceChannel({ channelId: channel.id, guildId: ctx.guild.id,
          adapterCreator: ctx.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
        s = { connection, player: api.createAudioPlayer(), channel: ctx.channel, voiceChannel: channel,
          lastCall: now(), nextCall: 0, abort: new AbortController(), closed: false, busy: false };
        session = s;
        s.player.on('error', () => { void tell(s, 'Falló la reproducción de voz. Me desconecto; puedes usar /entrar para reintentar.'); leave(s); });
        connection.on('error', () => leave(s));
        connection.on('stateChange', (_, state) => {
          if (state.status === api.VoiceConnectionStatus.Disconnected) leave(s);
        });
        await api.entersState(connection, api.VoiceConnectionStatus.Ready, 15000);
        if (s.closed) throw new Error('Conexión de voz cerrada.');
        s.lastCall = now();
        if (wakeFactory) {
          try {
            // Comprobar el modelo antes de anunciar que la activación funciona.
            const detector = wakeFactory(); detector.release();
            s.fixedDeadline = true;
            s.wake = startWakeListener({ receiver: connection.receiver, api, decoderFactory,
              detectorFactory: wakeFactory, setTimer, clearTimer,
              eligible: id => !s.closed && !s.busy && now() >= s.nextCall &&
                s.voiceChannel.members.has(id) && !s.voiceChannel.members.get(id).user.bot,
              onWake: (id, source) => { void respond(s, id, source); },
              onError: () => { void tell(s, 'El detector local falló. Usa /escuchar; la sesión conserva su límite de 10 minutos.'); },
            });
          } catch {
            await tell(s, 'No pude activar Hey TARS: faltan modelos locales o no pudieron cargarse. Sigo en modo /escuchar.');
          }
        }
        connection.subscribe(s.player); schedule(s);
        if (s.fixedDeadline) return await ctx.reply('Conectado por 10 minutos fijos. Di «Hey TARS» seguido de tu pregunta en la misma frase. Detecto la activación localmente; solo la pregunta se envía a Groq. Atiendo hasta dos hablantes simultáneos y no escucho mientras respondo. /escuchar también funciona.');
        return await ctx.reply('Conectado. Usa /escuchar y luego habla: capturo solo tu pregunta, hasta 12 segundos. Se envía a Groq para transcribirla; no guardo audio. Salgo tras 10 minutos sin llamados.');
      } catch (error) { leave(s); throw error; }
      finally { joining = false; }
    }
    const s = session;
    if (!s || s.voiceChannel.id !== channel.id) return ctx.reply('Debes estar en mi canal. Usa /entrar si todavía no estoy conectado.');
    if (command === 'salir') { leave(s); return ctx.reply('Desconectado del canal de voz.'); }
    if (s.busy || now() < s.nextCall) return ctx.reply('Espera a que termine y deja 20 segundos entre llamados.');
    return respond(s, ctx.user.id, undefined, ctx);
  }
  async function respond(s, userId, source, ctx) {
    s.busy = true;
    s.wake?.pause();
    if (!s.fixedDeadline) { s.lastCall = now(); s.expired = false; schedule(s); }
    s.nextCall = now() + 20000;
    try {
      // Se suscribe ANTES del aviso para no perder el inicio de la pregunta.
      const captured = capture(s, userId, source);
      if (ctx) await ctx.reply('Te escucho. Haz una pregunta breve y luego guarda silencio.');
      const pcm = await captured;
      if (s.closed) return;
      const question = await audio.transcribe(pcm, s.abort.signal);
      if (s.closed) return;
      if (!question) return await tell(s, 'No detecté una pregunta. Usa /escuchar para intentarlo otra vez.');
      const reply = await askAI(userId, question, { voice: true });
      if (s.closed) return;
      const wav = await audio.synthesize(reply, s.abort.signal);
      if (s.closed) return;
      s.resource = api.createAudioResource(Readable.from([wav]), { inputType: api.StreamType.Arbitrary });
      s.player.play(s.resource);
      await api.entersState(s.player, api.AudioPlayerStatus.Playing, 10000);
      await api.entersState(s.player, api.AudioPlayerStatus.Idle, 45000);
    } catch (error) {
      if (!s.closed) await tell(s, error.code === 'AI_BUDGET' ? error.message : 'No pude completar la respuesta de voz. No reintentaré automáticamente.');
    } finally {
      s.cancelCapture?.(); s.resource?.playStream.destroy(); s.resource = undefined;
      s.player.stop(true); s.busy = false;
      if (!s.closed && (s.expired || now() - s.lastCall >= IDLE_MS)) leave(s);
    }
  }
  function capture(s, userId, source) {
    return new Promise(resolve => {
      const initial = source?.initial?.subarray(0, MAX_AUDIO_BYTES) || Buffer.alloc(0);
      let chunks = [initial], size = initial.length, done = false;
      const input = source?.input || s.connection.receiver.subscribe(userId, { end: { behavior: api.EndBehaviorType.AfterSilence, duration: 900 } });
      const decoder = source?.decoder || decoderFactory();
      function finish(discard = false) {
        if (done) return;
        done = true; clearTimer(s.captureTimer);
        input.unpipe(decoder); input.destroy(); decoder.destroy();
        s.cancelCapture = undefined;
        resolve(discard ? Buffer.alloc(0) : Buffer.concat(chunks, size)); chunks = [];
      }
      s.cancelCapture = () => finish(true);
      input.on('error', () => finish(true)); decoder.on('error', () => finish(true));
      decoder.on('data', chunk => {
        const kept = chunk.subarray(0, MAX_AUDIO_BYTES - size);
        chunks.push(kept); size += kept.length;
        if (size >= MAX_AUDIO_BYTES) finish();
      });
      decoder.on('end', () => finish());
      s.captureTimer = setTimer(() => finish(), 12000);
      if (!source) input.pipe(decoder);
    });
  }
  function onVoiceState(oldState, newState) {
    const s = session;
    if (!s || oldState.guild.id !== s.voiceChannel.guild.id) return;
    if (newState.id === client.user.id && newState.channelId !== s.voiceChannel.id) return leave(s);
    if (![...s.voiceChannel.members.values()].some(m => !m.user.bot)) leave(s);
  }
  return { handle, leave, onVoiceState };
}
module.exports = { createVoice, IDLE_MS, MAX_AUDIO_BYTES };
