const { setTimeout: sleep } = require("node:timers/promises");

async function withAIRetry(operation, { wait = sleep, random = Math.random } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (![500, 502, 503, 504].includes(error?.status)) throw error;
      if (attempt === 2) {
        const unavailable = new Error("El proveedor de IA sigue temporalmente no disponible.", { cause: error });
        unavailable.code = "AI_UNAVAILABLE";
        throw unavailable;
      }
      // Dos reintentos: 1–1,5 segundos y 2–2,5 segundos.
      await wait(1000 * 2 ** attempt + Math.floor(random() * 500));
    }
  }
}

module.exports = { withAIRetry };
