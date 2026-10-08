# Voz de TARS con consumo mínimo

La activación elegida es manual: `/entrar`, `/escuchar`, luego hablar, y `/salir`.
También funcionan con `!`. No detecta «TARS» ni escucha conversaciones de fondo.
Sin `/escuchar` no hay suscripciones de recepción, decodificación ni llamadas de IA.
Solo captura al solicitante durante un máximo de 12 segundos, hasta 900 ms de
silencio al terminar. No hay grabaciones en disco ni transcripciones en logs.
La pregunta activada se envía a Groq; la respuesta se sintetiza localmente con
eSpeak NG, voz española robótica, sin una API de pago ni modelos grandes.

## Render

1. Usa el Dockerfile de este repositorio en un servicio Render con runtime Docker
   y selecciona explícitamente la instancia **Free**. Si el servicio actual usa
   Node nativo y no permite cambiar runtime, crea uno Docker y apaga el anterior
   antes de arrancar el nuevo: una sola instancia por token y registro de cuota.
2. Conserva los secretos actuales. Configura `TARS_VOICE_ENABLED=true`,
   `GROQ_API_KEY` y `TARS_STATE_CHANNEL_ID` (o `LOG_CHANNEL_ID`). Mantén la cuenta
   de Groq en Free; el código no puede consultar ni modificar tu facturación.
3. En el canal privado de estado, TARS necesita Ver canal, Leer historial,
   Enviar mensajes y Adjuntar archivos. No borres «TARS · Presupuesto IA · No borrar».
4. En voz necesita Ver canal, Conectar y Hablar. El canal desde donde ejecutas
   comandos debe permitir enviar mensajes a TARS. No admite escenarios Stage.
5. Despliega, usa `/entrar`, `/escuchar` y haz una pregunta. Comprueba la respuesta
   audible y `/salir`. Luego comprueba la salida tras 10 minutos sin invocaciones.
   No se ha verificado aquí la conexión UDP/DAVE real desde tu servicio Render.

La imagen instala ffmpeg y eSpeak NG. `npm ci` por sí solo en el runtime Node de
Render no instala esos programas. No ejecutes otra copia local mientras Render
utiliza el mismo token. Render Free puede suspenderse y reiniciarse; la voz no
garantiza disponibilidad 24/7. La recepción de audio de Discord tampoco tiene
garantía oficial de estabilidad.

## Límites deliberados

- Un canal en todo el proceso, una pregunta a la vez, 20 segundos entre llamados.
- Captura PCM mono a 16 kHz: máximo 384 KB por pregunta. Silencio o audio muy breve
  se descartan antes de la API (filtro de energía, no reconocimiento de voz).
- Una transcripción por pregunta; sin reintentos automáticos. Respeta 429.
- Respuestas de hasta 280 caracteres, prompt corto y solo un turno previo.
  Máximo de generación: 512 tokens en Groq; 256 en el respaldo configurado.
- Síntesis local bajo demanda. Sin detector de palabra clave ni proceso de IA
  local permanente. Al salir se cancelan captura, transcripción y reproducción.
  Una respuesta de texto ya en curso puede terminar, pero no se reproduce fuera.
- 10 minutos desde `/entrar` o el último `/escuchar` aceptado. La conversación
  ambiente y comandos rechazados no reinician el plazo. Termina una respuesta
  en curso antes de salir. También sale si el canal queda sin humanos.
- Con voz habilitada, texto y voz comparten un presupuesto de **100 intentos de
  API, 100.000 tokens estimados y 1.200 segundos de audio en 24 horas móviles**;
  máximo 6 intentos/minuto. Una pregunta usual usa dos intentos: transcripción
  y respuesta. Cada reintento o proveedor de respaldo consume otra reserva.
  La estimación de texto usa bytes UTF-8 más la generación máxima, deliberadamente
  conservadora; no es el conteo del proveedor. Audio reserva al menos 10 segundos.
- Las reservas se guardan en Discord antes de cada llamada y se recuperan tras
  reinicios. Si no se puede leer/escribir el registro, se bloquean las consultas.
  No borres ese mensaje. El registro exige una sola instancia de TARS.

Estos son topes internos conservadores, no una garantía de cubrir cada límite
por modelo de Groq ni uso de la misma clave en otras apps. Los 429 siguen vigentes.
No se habilitan planes de pago automáticamente. Si no quieres voz, establece
`TARS_VOICE_ENABLED=false`; esto también desactiva el presupuesto compartido.

Fuentes: [Render Free](https://render.com/docs/free),
[Groq](https://console.groq.com/docs/rate-limits),
[Discord Voice](https://discord.js.org/docs/packages/voice/0.19.2),
[eSpeak](https://espeak.sourceforge.net/commands.html).
