const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Memoria de conversaciones por usuario
const conversationHistory = new Map();

async function askAI(userId, userMessage) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction:
      "Eres un asistente amigable en un servidor de Discord. " +
      "Responde de forma concisa, útil y con buen humor. " +
      "Usa emojis ocasionalmente. No respondas con textos muy largos.",
  });

  // Obtener o crear historial del usuario
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }

  const history = conversationHistory.get(userId);

  // Iniciar chat con historial
  const chat = model.startChat({ history });

  // Enviar mensaje y obtener respuesta
  const result = await chat.sendMessage(userMessage);
  const response = result.response.text();

  // Guardar en historial (máx. 20 mensajes para no pasarse del límite)
  history.push(
    { role: "user", parts: [{ text: userMessage }] },
    { role: "model", parts: [{ text: response }] }
  );

  if (history.length > 20) {
    history.splice(0, 2); // Elimina los más viejos
  }

  return response;
}

// Limpiar historial de un usuario
function clearHistory(userId) {
  conversationHistory.delete(userId);
}

module.exports = { askAI, clearHistory };