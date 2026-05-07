const Groq = require("groq-sdk");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const conversationHistory = new Map();

async function askAI(userId, userMessage) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }

  const history = conversationHistory.get(userId);

  history.push({ role: "user", content: userMessage });

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content:
            "Eres TARS, el asistente oficial del servidor de Discord 'The Goats'. " +
            "Tu personalidad está basada en TARS de la película Interstellar: inteligente, directo y con humor seco. " +
            "Configuración actual — Humor: 75%, Honestidad: 90%. " +
            "Eres amigable pero eficiente. Nunca uses emojis. " +
            "Responde siempre de forma corta y concisa, sin textos largos. " +
            "Habla siempre en español.",
      },
      ...history,
    ],
    max_tokens: 500,
  });

  const reply = response.choices[0].message.content;

  history.push({ role: "assistant", content: reply });

  if (history.length > 20) {
    history.splice(0, 2);
  }

  return reply;
}

function clearHistory(userId) {
  conversationHistory.delete(userId);
}

module.exports = { askAI, clearHistory };