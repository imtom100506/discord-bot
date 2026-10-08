const { createServer } = require("node:http");

function keepAlive(port = process.env.PORT || 3000) {
  const server = createServer((req, res) => {
    const found = req.url.split("?")[0] === "/" && ["GET", "HEAD"].includes(req.method);
    res.writeHead(found ? 200 : 404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(found ? "TARS activo" : "No encontrado");
  });
  server.on("error", error => console.error("Error del servidor HTTP:", error.message));
  server.listen(Number(port));
  return server;
}

module.exports = keepAlive;
