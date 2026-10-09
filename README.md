# TARS

Bot de Discord con conversación por texto y voz. Se despliega usando el Dockerfile
en Render; configura los secretos y opciones indicados en `.env.example`.
No necesita una computadora personal encendida. Una sola instancia por token.

`!entrar` / `/entrar`: di «Hey TARS» seguido de tu consulta. Después de cada respuesta
tienes 8 segundos para continuar sin repetir la frase, solo con el mismo interlocutor.
Sale tras 5 minutos de inactividad. También admite `/escuchar` y `/salir`.
No escucha mientras habla. Las preguntas duran como máximo 12 segundos.

La detección y voz Davefx española se ejecutan localmente en Render. Los modelos
se descargan y verifican al construir Docker. Groq transcribe las preguntas y
genera respuestas; Cloudflare es un respaldo opcional para el texto. No se guardan
grabaciones ni transcripciones en los logs. El detector puede equivocarse con ruido
o acentos; `/escuchar` permite invocarlo manualmente.

## Consumo y diagnóstico

Con voz habilitada, el registro privado de Discord conserva los límites internos:
500 intentos de API, 100.000 tokens estimados y 3.600 segundos de audio por 24 horas
móviles. Se permiten 6 transcripciones y 6 respuestas por minuto, separadamente.
Cada intento se guarda antes de llamar al proveedor; los fallos también cuentan.
El audio reserva al menos 10 segundos por llamada. No borres el registro de cuota.
Estos topes son preventivos; los límites reales de cada proveedor siguen aplicando.
Mantén las cuentas en el plan gratuito: el bot no modifica la facturación.

El filtro por energía elimina silencios y golpes breves antes de transcribir;
no es un detector infalible de voz. Una continuación vacía no cierra la ventana
restante ni genera avisos. Durante una pausa de cuota no se capturan más preguntas.
Logs: `[voz:tiempos]` para latencia, `[voz:detector]` para recepción/detección y
`[voz:pausa]` para el motivo y tiempo restante de un límite interno.

## Desarrollo

Node 24. `npm ci`, `npm test`. Docker instala ffmpeg y eSpeak NG, además de los
modelos de voz. `TARS_WAKE_ENABLED=false` vuelve a la activación manual;
`TARS_TTS_ENGINE=espeak` usa la voz ligera. Render y los proveedores gratuitos
pueden suspender o limitar el servicio; no se garantiza disponibilidad permanente.

Referencia de límites: https://console.groq.com/docs/rate-limits
