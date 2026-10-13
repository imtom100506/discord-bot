// Gramática cerrada: solo órdenes dirigidas a TARS, nunca menciones narrativas.
function voiceControl(text) {
  let value = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const addressed = /^(?:(?:hey|oye|hola|por favor) )?tars\b\s*/;
  if (!addressed.test(value)) return null;
  value = value.replace(addressed, '');
  value = value.replace(/^(?:(?:muchas gracias|gracias|por favor|ya)\s+)+/, '')
    .replace(/(?:\s+(?:por favor|muchas gracias|gracias))+$/, '');
  if (/^(?:sal(?:te)?(?: del canal(?: de voz)?)?|desconectate(?: del canal(?: de voz)?)?|(?:puedes |podrias )?(?:irte|marcharte|retirarte)|vete|retirate|dejanos solos)$/.test(value)) return 'leave';
  if (/^(?:autodestruccion|autodestruyete|(?:activa|inicia|iniciar|activar)(?: la)? autodestruccion|(?:puedes |podrias )?autodestruirte)$/.test(value)) return 'countdown';
  return null;
}

// El plazo es independiente de la reproducción y de los fallos de audio.
function startCountdown(s, { audio, api, leave, log, cancel, setTimer, clearTimer }) {
  if (s.closed || s.countdown) return;
  s.countdown = true;
  cancel();
  clearTimer(s.idleTimer);
  log('voz_autodestruccion_inicio', { resultado: 'cuenta de 5 segundos' });
  s.countdownTimer = setTimer(() => leave(s, 'autodestruccion'), 5000);
  const { Readable } = require('node:stream');
  Promise.resolve().then(() => audio.countdown()).then(wav => {
    if (s.closed || !s.countdown) return;
    s.resource = api.createAudioResource(Readable.from([wav]), { inputType: api.StreamType.Arbitrary });
    s.player.play(s.resource);
  }).catch(error => log('voz_audio_error', { error: error.message, resultado: 'salida programada conservada' }));
}
module.exports = { voiceControl, startCountdown };
