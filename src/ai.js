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
          "Eres un asistente amigable en un servidor de Discord. " +
          "Responde de forma concisa, útil y con buen humor. " +
          "Usa emojis ocasionalmente. No respondas con textos muy largos.",
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