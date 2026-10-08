# IA de TARS

Groq (openai/gpt-oss-120b) es el proveedor principal. Cloudflare
(@cf/google/gemma-4-26b-a4b-it) se usa automáticamente cuando Groq falla,
si CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID están configurados.
Las claves solo van en .env o en los secretos del alojamiento. Nunca en Git.

Mantén Groq Free y Cloudflare Workers Free. El código no contrata planes,
no compra créditos ni cambia la facturación. Si la cuenta ya es de pago,
las llamadas pueden facturarse: el código no puede verificar tu plan.

## Activación

1. Añade GROQ_API_KEY a .env (ya existe una clave local).
2. En https://dash.cloudflare.com abre Workers AI > Use REST API.
3. Crea un token limitado a Workers AI de la cuenta y copia su Account ID.
4. Guarda CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID en .env.
5. Ejecuta npm test y reinicia el bot con npm start. Si el bot está alojado
   en otro servidor, despliega los archivos y configura allí los secretos.

## Render

Usa el servicio existente conectado a este repositorio. Build: `npm ci`.
Start: `npm start`. Node 24 se configura mediante `.node-version`.
Configura DISCORD_TOKEN, GROQ_API_KEY, CLOUDFLARE_API_TOKEN y
CLOUDFLARE_ACCOUNT_ID en Environment, sin publicar sus valores en Git.
Conserva LOG_CHANNEL_ID y cualquier otra variable existente del servidor.
El servidor HTTP usa el PORT asignado por Render.

Render Free puede suspender el servicio tras 15 minutos sin tráfico entrante;
los mensajes de Discord no son peticiones al endpoint HTTP de Render y no se
debe asumir que lo despertarán. Abre la URL del servicio para reactivarlo.
El alojamiento gratuito no garantiza que el bot esté disponible las 24 horas.
No ejecutes simultáneamente otra copia local con el mismo token de Discord.

## Moderación: apodos y timeout

Usa una mención real de Discord en lugar de escribir el nombre a mano:

```text
!tars cambia el apodo de @usuario a Nuevo apodo
!tars quita el apodo de @usuario
!tars mutea a @usuario por 10 minutos
!tars mutea a @usuario por 24 horas
!tars desmutea a @usuario
```

También funcionan en el campo `mensaje` de `/tars`, sin escribir `!tars`.
Se aceptan `mute`, `silencia`, `unmute` y `apodo @usuario Nuevo apodo`.
Las duraciones son enteras: segundos, minutos, horas o días (`s`, `m`, `h`, `d`),
entre 1 segundo y 28 días. El timeout restringe comunicación en el servidor,
no solo el micrófono; Discord lo retira al vencer aunque el bot esté apagado.
Los apodos admiten de 1 a 32 caracteres; no cambian el nombre global de la cuenta.

Para estas funciones, el solicitante necesita `Líder Supremo` o `Sigma` y el
permiso `Moderar miembros` (timeout) o `Gestionar apodos` (apodos). TARS también
necesita ese permiso. El objetivo debe tener un rol inferior al del solicitante
y al de TARS; el dueño solicitante está exento de la comprobación de su jerarquía.
No se permite actuar sobre uno mismo, sobre TARS o sobre el dueño. No se aplica
ni retira timeout a bots o administradores. La desconexión de voz existente
conserva su política anterior de roles.

El código valida y ejecuta estas acciones sin IA. Solo confirma éxito después de
la respuesta de Discord. Registra acciones, denegaciones y errores si existe
`LOG_CHANNEL_ID`, y envía el solicitante como motivo al registro de auditoría.

Referencia: [Modificar miembros en Discord](https://github.com/discord/discord-api-docs/blob/main/developers/resources/guild.mdx#modify-guild-member).

## Límites de ejecución

- Respuestas normales: 1–3 frases, hasta 600 caracteres. Una petición explícita
  de detalle o paso a paso permite hasta 1.500; los resúmenes conservan 600.
  Si la IA excede el límite, se conserva hasta una frase completa o se indica
  el recorte con puntos suspensivos. El historial guarda solo el texto enviado.
- La ayuda y las capacidades que recibe la IA se comparten en
  `src/botCapabilities.js`. Las consultas habituales de comandos y los comandos
  ficticios conocidos se contestan directamente, sin consultar al modelo.
  Los ajustes de personalidad no crean comandos ni funciones administrativas.
- Los logs de Discord muestran solo los primeros 400 caracteres de cada campo;
  una respuesta cortada en el log no implica que así se haya enviado al usuario.

- Cola global, una consulta a la vez, hasta ocho consultas y 90 segundos
  máximos de espera antes de empezar. Separación de 10 segundos por proveedor.
- Timeout de 20 segundos por intento, hasta dos reintentos en errores temporales.
- Ante 429 cambia al respaldo; respeta Retry-After antes de volver a ese proveedor.
  Sin cabecera, espera al menos un minuto. No insiste inmediatamente en cuota agotada.
- Errores de autenticación/modelo no se reintentan; el respaldo puede responder.
- Historial: hasta ocho mensajes y 4.000 caracteres, solo turnos exitosos.
  El contexto del servidor se envía una vez por petición y no se guarda en historial.
- Entradas superiores a 6.000 caracteres y contexto superior a 3.000 se recortan
  conservando inicio y final. Esto puede omitir material en resúmenes largos.
- Razonamiento bajo, 2.048 tokens máximos de generación en Groq y 1.024 en Cloudflare.
  Una respuesta vacía o truncada activa reintento/respaldo.
- Los límites por caracteres y el espaciado reducen consumo y ráfagas; no garantizan
  mantenerse bajo todas las cuotas. Se conserva el manejo de errores 429.

No se garantiza disponibilidad continua ni gratuidad perpetua del proveedor.
Fuentes: https://console.groq.com/docs/rate-limits y
https://developers.cloudflare.com/workers-ai/platform/pricing/
