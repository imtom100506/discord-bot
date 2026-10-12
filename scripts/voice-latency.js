const fs = require('node:fs');
const readline = require('node:readline');
async function main() {
  const file = process.argv[2];
  if (!file) throw Error('Uso: node scripts/voice-latency.js registro.log');
  const values = []; let errors = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.includes('[voz:error]')) errors++;
    const start = line.indexOf('[voz:latencia]');
    if (start < 0) continue;
    try {
      const value = JSON.parse(line.slice(start + '[voz:latencia]'.length).trim()).fin_a_reproduccion_ms;
      if (Number.isFinite(value) && value >= 0) values.push(value);
    } catch { /* Una línea truncada no es una muestra válida. */ }
  }
  values.sort((a, b) => a - b);
  const percentile = p => values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
  console.log(JSON.stringify({ respuestas_con_reproduccion: values.length, errores_de_voz: errors,
    p50_ms: percentile(0.5), p95_ms: percentile(0.95), menor_800_porcentaje: values.length ? 100 * values.filter(v => v < 800).length / values.length : null }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
