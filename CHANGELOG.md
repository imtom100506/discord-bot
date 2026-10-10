# Changelog de TARS

## 2026-10-10

- Entrada a voz: comprobaciones y conexión en paralelo, comprobaciones reutilizadas
  durante el despliegue y tiempos por etapa en `[voz:entrada]`.
- Comando sin IA `!borrar cantidad` / `!borrar @usuario cantidad`, también `/borrar`:
  hasta 50 mensajes directamente; de 51 a 100 con confirmación del solicitante en 30 segundos.
- Borrado restringido a Líder y Sigma con Gestionar mensajes. Protege fijados y registros
  internos, omite mensajes antiguos y revalida permisos y selección al confirmar.

## 2026-10-09

### Conversación por voz

- Continuación durante 8 segundos después de cada respuesta, sin repetir «Hey TARS»,
  para el mismo interlocutor. Eliminada la pausa obligatoria entre turnos.
- Sesiones con salida tras 5 minutos de inactividad, reiniciados con cada invocación
  o continuación aceptada; reemplaza el plazo fijo de diez minutos del modo anterior.
- Respuestas breves y conversacionales, y bienvenida simplificada.
- Detección de hasta tres hablantes simultáneos, con una respuesta a la vez y sin mezclar sus voces.
- Modelo de voz reutilizado durante la sesión y liberado al salir. Carga en segundo
  plano con voz ligera disponible mientras la voz neural se prepara.

### Estabilidad y consumo

- Corregida la captura manual que podía reutilizar un flujo de audio cerrado.
- Recuperación ante paquetes Opus inválidos aislados y errores puntuales de recepción;
  los errores persistentes conservan límites de recuperación.
- Mejor manejo de respuestas cortas, silencios y pausas después de «Hey TARS».
  Una continuación vacía ya no cierra la ventana restante ni genera avisos automáticos.
- Límites por minuto separados para transcripción y respuesta, evitando contar cada
  pregunta como dos llamadas contra un único tope. Márgenes diarios internos ajustados.
- Reservas de tokens ajustadas al consumo real informado por el proveedor;
  se conserva la estimación cuando ese dato no está disponible.
- Cancelación de consultas de voz al salir, contexto acotado y avisos de pausa con
  tiempo aproximado para reintentar. Se mantienen los controles de cuota gratuita.

### Registros y mantenimiento

- Saldo interno de tokens en `[IA:saldo]` después de cada consulta de IA, incluidos
  errores y bloqueos. `[IA:limite]` identifica el límite alcanzado y su recuperación.
- Diagnósticos por etapa para recepción, transcripción, generación y síntesis.
- Preguntas ya transcritas y respuestas reproducidas enviadas a `#logs-tars`, con
  autor, canal y hora, sin llamadas adicionales de IA. No registra audio de fondo.
- Guías de configuración consolidadas en un README breve.
- Pruebas de regresión para continuidad, tres hablantes, audio Opus real, reservas
  persistentes y registros de conversación.

## 2026-10-08

### Funciones

- Modo opcional «Hey TARS» con detector local sherpa-onnx sin cuenta, dos hablantes máximos,
  plazo fijo de diez minutos y reversión con `TARS_WAKE_ENABLED=false`.
- Voz masculina neural Davefx (primera voz española), tono grave, proceso temporal y respaldo eSpeak latino.
- Modo manual bajo demanda con `/entrar`, `/escuchar` y `/salir`, también con `!`.
- En modo manual, salida tras 10 minutos sin invocaciones y cuando el canal queda vacío.
- Transcripción limitada, síntesis local, presupuesto compartido persistido en Discord.
- Dockerfile e instrucciones de activación (actualmente en `README.md`).
- Mute de texto temporal y comando para retirarlo.
- Cambio y restablecimiento de apodos.
- Recuperación de mutes y vencimientos después de reinicios y despliegues.
- Controles de roles, permisos y jerarquía para moderación.

### Respuestas y ayuda

- Respuestas más cortas: hasta 600 caracteres, o 1.500 al pedir detalle.
- Ayuda basada en los comandos implementados y corrección de comandos ficticios.
- Identificación del usuario actual en el contexto de conversación.

### Mantenimiento

- Eliminación de dependencias de audio y clientes de IA sin uso.
- Exclusión de dependencias instaladas del seguimiento de Git.
- Servidor HTTP ligero con las herramientas integradas de Node.js.
- Memoria de conversaciones acotada y reutilización de las entradas recientes.
- Menos actualizaciones repetidas de permisos y escrituras del registro de mutes.
- Limpieza de mensajes de diagnóstico redundantes y actualización de la configuración de ejemplo.
- Pruebas de regresión de IA, comandos, moderación y persistencia.
