const DEFAULT_SUMMARY_COUNT = 20;

function summaryCount(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_SUMMARY_COUNT;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new Error("Indica una cantidad entera entre 1 y 50 mensajes.");
  }
  return count;
}

function countFromText(text) {
  const match = text.match(/[-+]?\d+(?:[.,]\d+)?/);
  return summaryCount(match ? match[0].replace(",", ".") : null);
}

function mentionedUserId(text) {
  const mentions = [...text.matchAll(/<@!?(\d+)>/g)];
  return mentions.length === 1 ? mentions[0][1] : null;
}

function splitResponse(text, limit = 1900) {
  if (!Number.isInteger(limit) || limit < 2) throw new RangeError("El límite debe ser al menos 2");
  const value = String(text);
  const chunks = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + limit, value.length);
    // No separar los dos componentes UTF-16 de un emoji.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks.length ? chunks : ["No recibí una respuesta. Intenta de nuevo."];
}

function appendContext(history, line, maxCharacters = 4000) {
  history.push(String(line).slice(-maxCharacters));
  let characters = history.reduce((sum, item) => sum + item.length + 1, -1);
  while (history.length > 50 || characters > maxCharacters) characters -= history.shift().length + 1;
  return history;
}

module.exports = { summaryCount, countFromText, mentionedUserId, splitResponse, appendContext };
