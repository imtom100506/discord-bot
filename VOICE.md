# Voz fija de TARS — revisión del 12 de octubre de 2026

## Causa encontrada y corrección

`voiceAudio.synthesize` elegía eSpeak cuando `warming` era true y Piper después.
El saludo global se lanzaba inmediatamente después de `void audio.warm()`, por lo
que reproducía exactamente esa carrera. Un fallo neural también fijaba un fallback
a eSpeak hasta cerrar la sesión. Incluso había un test que exigía ese cambio.

Ahora no hay sustitución de motor. Toda frase espera a Piper o se reutiliza desde
WAV. Cada archivo debe ser PCM16 mono completo antes de llegar al reproductor.
Solo se reintenta una vez con el mismo perfil; tras dos fallos se pausa la generación
60 segundos y se entrega la respuesta completa por texto. Los pregenerados y aciertos
de caché siguen disponibles. Cancelar/salir impide reproducir resultados tardíos.

El perfil único de `src/voiceProfile.js` fija modelo, versión del motor, speaker,
ruido, velocidad, tono y formato. Su hash y el texto normalizado forman la clave de
caché. Cambiar cualquier parámetro invalida los audios anteriores. La descarga del
modelo en Docker verifica el SHA-256 del archivo oficial. Para reemplazar pesos
manualmente hay que actualizar modelo/checksum en ese perfil y regenerar audios.

Se conserva texto completo, incluyendo el final de explicaciones largas: ambos
modos de voz dividen en fragmentos, sin el antiguo corte TTS a 280 caracteres.
El bot recibe la respuesta textual completa antes de hablar; se sacrifica la ventaja
de SSE para que un fallo de generación del texto no deje respuestas habladas parciales.
Un fallo TTS posterior a fragmentos ya reproducidos puede dejar audio parcial, pero
el chat recibe toda la respuesta y nunca se cambia de voz. El prompt pide brevedad
por defecto, permite explicación y conserva idioma; Whisper ya no fuerza español.
Piper es monolingüe: puede pronunciar mal otros idiomas sin traducirlos.

## Aproximación elegida y recursos

Referencia solicitada: doblaje latinoamericano. Piper `es_MX-claude-high-int8`
es un candidato gratuito con pronunciación mexicana, un solo speaker, CPU y sin
servicio TTS externo. **No es la voz del actor ni se ha comprobado semejanza auditiva
con TARS**. No se promete una réplica casi idéntica con Render Free. El perfil
mantiene el ajuste grave existente (tasa ×0,90 y velocidad ×1,06); bajar la tasa
también afecta velocidad, no es una clonación de timbre.

La ficha incluida declara dataset Apache-2.0; conservar los avisos del archivo.
[Ficha del modelo](https://huggingface.co/rhasspy/piper-voices/blob/main/es/es_MX/claude/high/MODEL_CARD).
No se añaden servicios con pruebas temporales. No hay GPU ni entrenamiento.

Medición local de muestra «TARS operativo. Listo para recibir instrucciones.»:
modelo mexicano, carga + síntesis 2,03 s de pared / 1,984 s CPU / RSS final 136,6 MiB.
Es solo el proceso de síntesis, no un pico agregado ni una medición de Render.
El modelo anterior de España marcó 1,84 s / 141 MiB RSS en otra ejecución local.
No permite concluir cuál suena más fiel ni predecir latencias de producción.
Una segunda prueba real del flujo completo local midió 2 ms para el saludo
pregenerado, 2.116 ms para una respuesta nueva y 1 ms al repetirla. Se verificó
igualdad exacta de los bytes reutilizados. Muestra guardada en `data/tars-muestra.wav`.

Tu plan declarado es Web Service Free. La documentación actual indica
[0,1 CPU y 512 MB](https://render.com/docs/compute-plans): falta medir RSS conjunto
de Node, Piper, VAD por hablante, decodificadores y ffmpeg bajo carga. Varias personas
y explicaciones largas pueden superar CPU/RAM. La generación usa un worker y un
hilo; cola TTS máxima 8, caché 8 MiB/64 entradas; la cola del canal sigue serializada.
Carga máxima 45 s, síntesis 15 s por intento. Con CPU insuficiente habrá texto.
Si la escucha global consume demasiado, `TARS_GLOBAL_LISTENING=false` y
`TARS_WAKE_ENABLED=false` permiten captura manual con /escuchar y ahorran VAD continuo.

## WAV y reutilización

| Formato ilustrativo | Tamaño por minuto | Coste y utilidad |
| --- | ---: | --- |
| WAV PCM16 mono del perfil, 19.845 Hz | 2,38 MB | Salida directa del motor, sin compresión adicional |
| WAV PCM16 mono, 48 kHz | 5,76 MB | Aumenta tamaño sin añadir detalle al modelo |
| Opus a 24 kbit/s | 0,18 MB + contenedor | Mucho menor; requiere codificar, y parámetros compatibles con Discord para evitar recodificar |
| MP3 a 64 kbit/s | 0,48 MB + contenedor | Compresión con pérdidas, codificación y posterior decodificación |

Son tamaños calculados, no un benchmark de códecs. Se elige WAV porque el paquete
de 10 frases ocupa 1.026.930 bytes y la caché en RAM está acotada. Evita codificar
un formato intermedio en Render. Discord igualmente requiere remuestreo/codificación
a Opus mediante el reproductor; WAV no viaja tal cual al usuario. Guardar MP3/WAV
no determina por sí mismo el ancho de banda Discord. No se prometen ahorros de
tokens por formato: las frases locales evitan LLM, la caché evita TTS; una respuesta
contextual nueva todavía puede necesitar LLM aunque coincida el audio resultante.

`npm run voice:pregenerate` se ejecuta en el PC con modelos instalados. Usa el mismo
perfil/caché y guarda solo las 10 frases definidas en `scripts/pregenerate-voice.js`.
Elimina versiones antiguas de esos archivos generados y limita el paquete a 8 MiB.
Docker copia `audio/`; no genera esas frases al arrancar ni depende de un PC conectado.
Los WAV generados deben incluirse junto al código en el despliegue. Cambiar el perfil
requiere volver a ejecutar el comando; si falta un archivo válido se genera con el
perfil vigente, nunca se reutiliza el de otra voz.

Respuestas nuevas se guardan únicamente en caché LRU RAM, sin crecer el disco ni
guardar conversaciones en WAV permanentes. Sobreviven al cierre del canal, no al
reinicio del proceso. Pregenerados incluidos en Docker sobreviven a despliegues;
la caché de ejecución se pierde, acorde con el disco efímero de Render Free.

## Gratuidad y límites comprobados

- [Render Free](https://render.com/docs/free): 750 horas/mes compartidas por workspace,
  suspensión tras 15 minutos sin tráfico entrante, disco efímero y sin disco persistente.
  Cuotas de transferencia/build dependen del workspace. Excesos pueden cobrarse si hay
  método de pago; sin él se suspenden servicios/builds. No se ha accedido a tu panel
  ni confirmado tus consumos, tarjeta o límites de gasto. Free no garantiza bot 24/7.
- [Groq Free](https://console.groq.com/docs/rate-limits): Whisper Turbo publica 20 RPM,
  2.000 RPD, 7.200 segundos/hora y 28.800/día. GPT-OSS-120B: 30 RPM, 1.000 RPD,
  8.000 TPM y 200.000 TPD. Los límites exactos dependen de tu organización. Mantener
  cuenta Free; no se cambia ningún plan. Se conservan cuotas locales más restrictivas
  (500 intentos, 100.000 tokens y 3.600 s audio/24h; 6 RPM por tipo) y Retry-After.
- [Deepgram](https://deepgram.com/pricing) ofrece créditos iniciales y después cobra.
  Se rechaza `TARS_STT_PROVIDER=deepgram` antes de conectarse.
- El respaldo LLM Cloudflare preexistente es opcional. [Workers AI Free](https://developers.cloudflare.com/workers-ai/platform/pricing/)
  incluye 10.000 neuronas/día; no equivale a tokens. Para un despliegue solo Groq deja
  vacías `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`. No se han alterado credenciales.
  El código no puede deducir el plan de facturación de una API key.

## Verificación y puesta en servicio

`npm test`: 118 pruebas aprobadas. Verifica espera del primer audio, reutilización idéntica de bytes,
pregenerado sin cargar modelo, serialización y deduplicación, límites LRU/cola,
invalidación de perfil, WAV corrupto, dos fallos sin otro motor, respuesta textual
y cancelación. Hay síntesis real local para los diez WAV; los tests de Discord y
fallos de proveedores usan dobles, no llamadas de pago ni mensajes a tu servidor.
No había Docker disponible en este equipo para construir y medir la imagen Linux.

Desplegar Docker con `TARS_TTS_ENGINE=piper`, `TARS_STT_PROVIDER=groq`, voz habilitada
y las credenciales existentes. Probar /entrar recién reiniciado, una pregunta inédita,
/repite y una explicación larga. Verificar RSS y duración en Render. Para probar fallo,
usar las pruebas inyectadas, sin romper la producción. No se ha desplegado ni escuchado
una sesión real de Discord: consistencia del motor sí verificada; fidelidad al actor
y rendimiento en Render pendientes de validación auditiva y operativa.
