const { Transform } = require('node:stream');

function createOpusDecoder({ codec } = {}) {
  if (!codec) {
    const Opus = require('opusscript');
    codec = new Opus(16000, 1, Opus.Application.VOIP);
  }
  let consecutive = 0, dropped = 0;
  return new Transform({
    writableObjectMode: true,
    transform(packet, encoding, done) {
      let pcm;
      try { pcm = codec.decode(packet); consecutive = 0; }
      catch (error) {
        // Un paquete corrupto no invalida los siguientes. Limitar la recuperación.
        if (error.message === 'Decode error: Invalid packet' && ++consecutive < 5) {
          if (++dropped === 1) console.warn('[voz:opus] Paquete inválido descartado; continúo recibiendo.');
          return done();
        }
        return done(error);
      }
      done(null, pcm);
    },
    destroy(error, done) {
      try { codec.delete(); done(error); } catch (failure) { done(error || failure); }
    },
  });
}
module.exports = { createOpusDecoder };
