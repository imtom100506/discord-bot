const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("✅ Bot activo!");
});

function keepAlive() {
  const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor keep-alive corriendo en puerto ${PORT}`);
});
}

module.exports = keepAlive;