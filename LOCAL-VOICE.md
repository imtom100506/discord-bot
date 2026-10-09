# Voz y activación locales, sin cuentas adicionales

## Activación en Render

Sube los cambios al repositorio y reconstruye el servicio Docker. La imagen
descarga automáticamente los dos modelos públicos de k2-fsa y verifica sus
hashes SHA-256. No hay que descargar modelos en tu PC ni mantenerlo encendido.

Variables de Environment:

```text
TARS_VOICE_ENABLED=true
TARS_WAKE_ENABLED=true
TARS_TTS_ENGINE=piper
```

Conserva GROQ_API_KEY, DISCORD_TOKEN y el canal de estado existente. Ya NO hacen
falta PICOVOICE_ACCESS_KEY, TARS_WAKE_KEYWORD_PATH ni TARS_WAKE_MODEL_PATH.
No se llama a Picovoice. Todas las dependencias se fijan en package-lock.json.

## Uso y límites

`/entrar` abre una sesión de diez minutos fijos, aunque sigas haciendo preguntas.
Di «Hey TARS» con pronunciación aproximada «jei tars», seguido de la pregunta,
sin dejar una pausa de un segundo. La detección usa un modelo inglés/chino y
fonemas ingleses; no se garantiza reconocimiento del acento español/chileno.
Solo la pregunta posterior a la activación va a Groq. Una activación falsa puede
consumir cuota; no existe garantía de cero errores con cualquier detector.

Un solo modelo pequeño compartido, un hilo de CPU, dos hablantes simultáneos
como máximo. No escucha mientras responde ni durante la pausa de 20 segundos
entre preguntas. Intervenciones continuas de más de 30 segundos se interrumpen:
hay que hacer una pausa antes de invocarlo de nuevo. Las preguntas conservan el
tope de 12 segundos. `/escuchar` y `/salir` siguen disponibles.

La voz Davefx es masculina y española (es_ES), con el tono reducido un 10% y cadencia
ajustada. Es una aproximación de carácter grave/robótico, no una copia de la voz
de la película. Las respuestas tienen hasta 180 caracteres para reducir demora.
El modelo de voz se carga en un proceso temporal de un hilo, se libera tras
cada respuesta y se cancela al salir. Si falla o excede 45 segundos, utiliza
eSpeak latino masculino grave como respaldo. El presupuesto de Groq sigue
guardándose antes de cada llamada. La síntesis y la detección no usan Groq.

## Evidencia y limitaciones

Pruebas locales de referencia: detección positiva con dos muestras sintéticas
inglesas de «Hey TARS». Una muestra sintetizada en español NO fue reconocida.
Esto no demuestra precisión con voces humanas, ruido, micrófonos de Discord ni
acentos chilenos. No se ha medido dentro de la instancia Render del usuario.
No activar como servicio confiable sin probarlo con las voces reales del canal.

La voz seleccionada (Davefx, España) generó aproximadamente 5,9 segundos de audio en 2,6 segundos,
con unos 146 MB de RSS en el proceso de prueba. Estas cifras no son garantías
para Render Free (0,1 CPU): puede tardar considerablemente más.

Para una prueba reproducible con un WAV mono de activación:

```text
npm run models:download
node scripts/smoke-local-speech.js ruta/al/hey-tars.wav
```

El script comprueba el positivo proporcionado y una muestra negativa española.
Las pruebas unitarias de `npm test` usan detectores simulados y no miden precisión.

## Volver al modo ligero

```text
TARS_WAKE_ENABLED=false
TARS_TTS_ENGINE=espeak
```

Guardar y redesplegar restaura `/escuchar`, diez minutos de inactividad y voz
ligera. También puedes apagar solo la detección o cambiar solo la voz.

## Fuentes

- https://k2-fsa.github.io/sherpa/onnx/kws/index.html
- https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html
- https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html
- https://huggingface.co/rhasspy/piper-voices/tree/main/es/es_ES/davefx/medium
- https://github.com/dscripka/openWakeWord (alternativa investigada; requiere entrenar la frase personalizada)
