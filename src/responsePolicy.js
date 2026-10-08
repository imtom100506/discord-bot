function responseLimit(text) {
  // Solo la petición actual habilita detalle; nunca los mensajes del historial.
  return /\b(?:en detalle|con detalle|m[aá]s detalles?|detallad[oa]|paso a paso|a fondo|extens[oa]|analiza|explica ampliamente)\b/i.test(text) ? 1500 : 600;
}

function compactResponse(text, limit) {
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit - 1);
  // Preferir una frase completa a cortar una explicación a mitad de palabra.
  const sentences = [...prefix.matchAll(/[.!?](?=\s|$)/g)];
  const end = sentences.at(-1)?.index;
  if (end !== undefined && end >= limit / 3) return prefix.slice(0, end + 1).trim();
  const boundary = prefix.lastIndexOf(" ");
  return (boundary > 0 ? prefix.slice(0, boundary) : [...prefix].filter(c => !/[\uD800-\uDFFF]/u.test(c)).join("")).trimEnd() + "…";
}

module.exports = { responseLimit, compactResponse };
