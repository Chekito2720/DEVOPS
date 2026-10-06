const net = require("net");
const app = require("./app");
const { db } = require("./db");

const PORT = process.env.PORT || 80;

app.listen(PORT, () => console.log(`API escuchando en el puerto ${PORT}`));

// ---------- Servidor TCP crudo (puerto 6061) ----------
const tcpServer = net.createServer((socket) => {
  socket.on("data", (data) => {
    const msg = data.toString().trim();

    // {insert:<element>} -> insertar producto
    let match = msg.match(/^\{insert:(.+)\}$/s);
    if (match) {
      try {
        const element = JSON.parse(match[1]);
        const stmt = db.prepare("INSERT INTO productos (nombre, precio, categoria_id) VALUES (?, ?, ?)");
        const info = stmt.run(element.nombre, element.precio, element.categoria_id);
        socket.write(JSON.stringify({ statusCode: 200, data: { id: Number(info.lastInsertRowid) } }) + "\n");
      } catch (e) {
        socket.write(JSON.stringify({ statusCode: 400, error: "Formato invalido" }) + "\n");
      }
      return;
    }

    // {get:<element>} -> obtener producto por id, ej. {"id":1}
    match = msg.match(/^\{get:(.+)\}$/s);
    if (match) {
      try {
        const id = JSON.parse(match[1]).id;
        const row = db.prepare(`
          SELECT p.id, p.nombre, p.precio, p.categoria_id, c.nombre AS categoria
          FROM productos p
          JOIN categorias c ON c.id = p.categoria_id
          WHERE p.id = ?
        `).get(id);
        socket.write(JSON.stringify({ statusCode: row ? 200 : 404, data: row || null }) + "\n");
      } catch (e) {
        socket.write(JSON.stringify({ statusCode: 400, error: "Formato invalido" }) + "\n");
      }
      return;
    }

    socket.write(JSON.stringify({ statusCode: 400, error: "Comando no reconocido" }) + "\n");
  });
});

tcpServer.listen(6061, "0.0.0.0", () => {
  console.log("Servidor TCP escuchando en puerto 6061");
});
