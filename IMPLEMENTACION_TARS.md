# Cambios de TARS — 12 de octubre de 2026

## Resultado

- Detección local y conservadora de salida/autodestrucción sobre STT final, antes del modelo conversacional. Acepta las formulaciones solicitadas y rechaza negaciones, menciones narrativas y preguntas explicativas.
- Recepción prioritaria durante respuestas; aborta generación/síntesis/reproducción y elimina suscripciones, capturas y temporizadores de la sesión. La cola de respuestas ya no ocupa todas las ranuras de transcripción e impide recibir la salida.
- Cuenta regresiva con WAV pregenerado del perfil actual de TARS: cinco ranuras de un segundo. Temporizador independiente, órdenes repetidas no lo reinician y una salida normal lo interrumpe. No hay generación de audio ni llamadas al modelo al ejecutarla.
- Eliminados el comando de privacidad, su variante slash, registro, handlers y referencias de ayuda/documentación. Regenerado el audio de ayuda que lo mencionaba. Se conservan exclusiones guardadas, permisos, protección de credenciales y borrado de memoria mediante /reset.
- Se conserva la restricción existente de una sola sesión de voz a la vez. Los eventos de otros servidores se ignoran; no se añaden conexiones paralelas ni reconexión automática.

## Causa encontrada de los logs

El archivo .env local no define LOG_CHANNEL_ID. El sendLog anterior retornaba sin diagnóstico cuando faltaba esa variable, y también omitía silenciosamente destinos incompatibles. Los registros de conversación de voz usaban otro camino hacia logs-tars, y los eventos operativos de voz no estaban conectados a sendLog. En el modo global los registros de conversación están desactivados por defecto: no equivalen a logs operativos.

El nuevo emisor respeta LOG_CHANNEL_ID si está configurado. Sin él resuelve el canal existente logs-tars del servidor del evento mediante caché/fetch. No inventa IDs ni crea canales. Para eventos globales sin servidor requiere un destino inequívoco; con varios canales candidatos debe configurarse el ID.

Verifica tipo de canal y permisos efectivos. Registra comandos procesados, acciones/denegaciones de moderación, borrados, restauración de mutes, errores, conexión/desconexión, controles/respuestas de voz, fallos de STT/TTS y proveedores de IA, inicio/fin de cuenta regresiva y eventos del cliente Discord. Cada evento lleva fecha UTC, contexto disponible, resultado y detalles pertinentes.

Cola limitada a 100 registros, separación de 1,1 s y hasta dos reintentos ante 429/5xx. Respeta Retry-After; si supera un minuto omite el registro con diagnóstico en vez de reintentar antes de tiempo. Nonce estable por registro para deduplicar reintentos. No reenvía fallos de red ambiguos. Los errores del propio emisor solo van a consola, evitando bucles. No envía textos completos de mensajes/respuestas, audio o credenciales. Las conversaciones de voz siguen requiriendo TARS_VOICE_LOG_ENABLED=true explícito, también en el modo anterior.

## Archivos

- src/voiceControl.js: gramática de órdenes y temporizador de cuenta regresiva.
- src/priorityReceiver.js: recepción limitada de controles durante respuestas del modo anterior.
- src/voice/channelVoice.js y src/voice.js: integración, prioridad, cancelación, restricciones y logs.
- src/optimization/lowLatencyPipeline.ts: retirado el detector antiguo de salida que admitía órdenes sin invocación explícita.
- src/voiceAudio.js: lectura de la cuenta regresiva desde caché, sin sintetizarla.
- scripts/pregenerate-voice.js y audio/pregenerated/: nueva cuenta regresiva y ayuda hablada actualizada; retirado el WAV antiguo de ayuda sin uso.
- src/operationalLog.js: resolución, permisos, cola, reintentos, contexto y redacción de secretos.
- src/index.js: registro de comandos, integración de logs y eventos operativos.
- src/aiClient.js: evento seguro de fallo de proveedor, incluido cuando existe respaldo.
- src/botCapabilities.js: ayuda y capacidades corregidas.
- .env.example y README.md: configuración, comportamiento y límites actualizados.
- test/voiceControl.test.js y test/operationalLog.test.js: pruebas nuevas.
- test/globalVoice.test.js, test/voice.test.js, test/commands.test.js y test/aiClient.test.js: integración y regresiones.
- IMPLEMENTACION_TARS.md: este informe.

## Comprobaciones ejecutadas

- npm run voice:pregenerate: generación local correcta con el perfil Piper existente; sin nuevas dependencias ni servicios.
- npm test: 161 pruebas aprobadas, cero fallos. Se ejecutó fuera del sandbox porque este bloqueó inicialmente una conexión HTTP local y un renombrado temporal.
- Pruebas específicas de voz/logs repetidas tras los últimos ajustes: aprobadas.
- WAV validado como PCM16 mono completo, exactamente cinco segundos y cinco segmentos con señal de audio; lectura repetida sin síntesis.
- Variantes, negaciones, salida durante reproducción, cancelación del modelo, ocho turnos pendientes, respuesta tardía, limpieza, eventos de otro servidor, usuarios ajenos/bots, repetición de cuenta regresiva, fallo de audio y salida anticipada.
- Logs con Discord simulado: destino por ID/caché/fetch/nombre existente, falta de permisos, redacción, 429/503/403, límites de cola y envíos serializados.
- Comando eliminado de ayuda y rechazado por las rutas slash/prefijo; exclusiones persistidas todavía aplicadas.
- git diff --check: sin errores de formato.

## Pendiente en producción

No inicié sesión con el bot ni desplegué en Render. La configuración y permisos efectivos de producción no fueron consultados; la causa comprobada de configuración corresponde al .env local, no demuestra por sí sola la configuración remota.

Tras desplegar/reiniciar, verificar el canal real y la recepción de logs; el registro global de comandos retirará la variante slash anterior. Probar audio con usuarios reales, incluidos auriculares/eco y una orden mientras habla. La duración del archivo y el temporizador son cinco segundos; Discord, red y planificación del proceso pueden introducir latencia audible. La salida hablada depende de que STT pueda transcribir bajo sus cuotas existentes; /salir sigue disponible sin STT.

En el modo anterior, estando inactivo se conserva /escuchar o Hey TARS; durante una respuesta se recibe voz para controles prioritarios. El modo global recibe continuamente cuando está habilitado. No se añade cancelación acústica de eco ni un servicio de pago.
