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
  const chunks = [];
  let chunk = "";
  for (const character of String(text)) {
    if (chunk.length + character.length > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks.length ? chunks : ["No recibí una respuesta. Intenta de nuevo."];
}

module.exports = { summaryCount, countFromText, mentionedUserId, splitResponse };
