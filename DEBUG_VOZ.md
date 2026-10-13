# Diagnóstico del incidente de voz

Los registros aportados prueban bloqueos locales requests_minute (6 solicitudes)
y latencias de 8,255 a 39,171 segundos. No prueban agotamiento de tokens: el saldo
81.751–82.601 mostrado pertenece al contador interno de 24 horas. Tampoco demuestran
por sí solos un fallo de Render ni permiten dividir la latencia entre STT, colas,
persistencia de cuotas, modelo y TTS. Los mensajes de puerto UDP son informativos.

Causas del código: ambas clases de llamadas tenían un tope independiente de 6/min;
el STT global procesa también conversaciones que no llevan a una respuesta. Un
corte tras 240 ms de silencio fragmentaba pausas normales. Cualquier AI_BUDGET
bloqueaba toda recepción y no invalidaba las respuestas ya en cola, produciendo
avisos de pausa intercalados con respuestas. El corte de antigüedad solo se evaluaba
antes del modelo, por lo que la síntesis podía iniciar reproducción muy tarde.

Correcciones: límites STT/LLM configurables (20/6 al arrancar), silencio 650 ms,
pausas separadas, aviso con servicio/segundos, descarte de trabajo anterior al
bloqueo, cola de tres turnos con sustitución de pendientes del mismo usuario y
entrega por texto después de 15 s. Preparación del modelo de voz al conectar y
métricas por etapa. Se preservan los límites diarios y las respuestas 429 reales.
No se borra ni reinicia el registro de cuotas.

Logs: formato compartido con evento, usuario, canal por nombre y enlace, fecha/hora
local de Discord y detalles legibles. Resolución caché/fetch del canal de origen.
Se mantienen cola limitada, redacción, reintentos y menciones sin notificación.
El modo de conversación completa sigue desactivado salvo configuración explícita.

Voz: modelo cambiado de Claude a Ald, español de México, con ajuste de tono grave.
Perfil, hash de descarga y claves de caché actualizados; WAVs y cuenta regresiva
regenerados. Fuente: https://huggingface.co/csukuangfj/vits-piper-es_MX-ald-medium/blob/main/MODEL_CARD
La muestra local está en audio/tars-ald-grave-demo.wav. No es clonación de un actor.

Validación: npm test, 166 pruebas aprobadas. Nuevos casos: 20 transcripciones y
6 consultas independientes, servicio/espera exactos, salida durante pausa LLM,
una sola notificación por pausa, síntesis tardía por texto, agrupación de pausas
breves y formato con nombre del canal. Pregeneración real y WAV de cinco segundos
verificados por las pruebas existentes. No se probó el bot conectado a Discord
ni se desplegó a Render. Hay que reconstruir/desplegar para descargar el nuevo
modelo y aplicar código/audio; no basta sustituir variables de entorno.
