# Changelog de TARS

## 2026-10-08

### Funciones

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
