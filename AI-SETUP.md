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

## Límites de ejecución

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
