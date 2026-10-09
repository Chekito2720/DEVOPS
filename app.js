const express = require("express");
const path = require("path");
const { db, BACKUP_DIR } = require("./db");

const app = express();
app.use(express.json());

// Helpers: mismo schema en todas las respuestas
function ok(res, data, code = 200) {
  return res.status(code).json({ statusCode: code, data });
}
function fail(res, code, msg) {
  return res.status(code).json({ statusCode: code, error: msg });
}

// Valida que el :id de la ruta sea un entero positivo
function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// 0. GET /api/health (healthcheck del pipeline)
app.get("/api/health", (req, res) => {
  ok(res, {
    status: "ok",
    autor: "Revizando",
    fecha: new Date().toISOString(),
  });
});

// ---------- Categorias ----------
// 1. GET /api/categorias
app.get("/api/categorias", (req, res) => {
  const rows = db.prepare("SELECT * FROM categorias ORDER BY id").all();
  ok(res, rows);
});

// 2. POST /api/categorias
app.post("/api/categorias", (req, res) => {
  const { nombre } = req.body || {};
  if (typeof nombre !== "string" || !nombre.trim()) {
    return fail(res, 400, "nombre es requerido y debe ser texto no vacio");
  }
  try {
    const info = db.prepare("INSERT INTO categorias (nombre) VALUES (?)").run(nombre.trim());
    const row = db.prepare("SELECT * FROM categorias WHERE id = ?").get(info.lastInsertRowid);
    ok(res, row, 201);
  } catch (e) {
    fail(res, 409, "La categoria ya existe o es invalida: " + e.message);
  }
});

// 3. DELETE /api/categorias/:id
app.delete("/api/categorias/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return fail(res, 400, "id debe ser un numero entero valido");
  try {
    const info = db.prepare("DELETE FROM categorias WHERE id = ?").run(id);
    if (info.changes === 0) return fail(res, 404, "Categoria no encontrada");
    ok(res, { eliminado: id });
  } catch (e) {
    fail(res, 409, "No se puede eliminar: tiene productos asociados");
  }
});

// ---------- Productos ----------
// 4. GET /api/productos (JOIN con categoria)
app.get("/api/productos", (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.nombre, p.precio, p.categoria_id, c.nombre AS categoria
    FROM productos p
    JOIN categorias c ON c.id = p.categoria_id
    ORDER BY p.id
  `).all();
  ok(res, rows);
});

// 5. POST /api/productos
app.post("/api/productos", (req, res) => {
  const { nombre, precio, categoria_id } = req.body || {};
  if (typeof nombre !== "string" || !nombre.trim()) {
    return fail(res, 400, "nombre es requerido y debe ser texto no vacio");
  }
  if (typeof precio !== "number" || !Number.isFinite(precio) || precio < 0) {
    return fail(res, 400, "precio debe ser un numero mayor o igual a 0");
  }
  if (!Number.isInteger(categoria_id)) {
    return fail(res, 400, "categoria_id debe ser un numero entero");
  }
  const cat = db.prepare("SELECT id FROM categorias WHERE id = ?").get(categoria_id);
  if (!cat) return fail(res, 400, "categoria_id no existe");
  try {
    const info = db
      .prepare("INSERT INTO productos (nombre, precio, categoria_id) VALUES (?, ?, ?)")
      .run(nombre.trim(), precio, categoria_id);
    const row = db.prepare("SELECT * FROM productos WHERE id = ?").get(info.lastInsertRowid);
    ok(res, row, 201);
  } catch (e) {
    fail(res, 400, "Error al crear producto: " + e.message);
  }
});

// 6. DELETE /api/productos/:id
app.delete("/api/productos/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return fail(res, 400, "id debe ser un numero entero valido");
  try {
    const info = db.prepare("DELETE FROM productos WHERE id = ?").run(id);
    if (info.changes === 0) return fail(res, 404, "Producto no encontrado");
    ok(res, { eliminado: id });
  } catch (e) {
    fail(res, 409, "No se puede eliminar: tiene pedidos asociados");
  }
});

// ---------- Pedidos ----------
// 7. GET /api/pedidos
app.get("/api/pedidos", (req, res) => {
  const rows = db.prepare(`
    SELECT pe.id, pe.producto_id, pr.nombre AS producto, pe.cantidad, pe.fecha
    FROM pedidos pe
    JOIN productos pr ON pr.id = pe.producto_id
    ORDER BY pe.id
  `).all();
  ok(res, rows);
});

// 8. POST /api/pedidos
app.post("/api/pedidos", (req, res) => {
  const { producto_id, cantidad } = req.body || {};
  if (!Number.isInteger(producto_id)) {
    return fail(res, 400, "producto_id debe ser un numero entero");
  }
  const prod = db.prepare("SELECT id FROM productos WHERE id = ?").get(producto_id);
  if (!prod) return fail(res, 400, "producto_id no existe");
  if (typeof cantidad !== "number" || !Number.isInteger(cantidad) || cantidad <= 0) {
    return fail(res, 400, "cantidad debe ser un numero entero mayor a 0");
  }
  try {
    const info = db
      .prepare("INSERT INTO pedidos (producto_id, cantidad) VALUES (?, ?)")
      .run(producto_id, cantidad);
    const row = db.prepare("SELECT * FROM pedidos WHERE id = ?").get(info.lastInsertRowid);
    ok(res, row, 201);
  } catch (e) {
    fail(res, 400, "Error al crear pedido: " + e.message);
  }
});

// ---------- Endpoints especiales ----------
// 9. GET /api/db/backup
app.get("/api/db/backup", async (req, res) => {
  const file = path.join(BACKUP_DIR, `backup-${Date.now()}.db`);
  try {
    await db.backup(file);
    ok(res, { backup: file });
  } catch (e) {
    fail(res, 500, "Error al crear backup: " + e.message);
  }
});

// 10. DELETE /api/db/clear
app.delete("/api/db/clear", (req, res) => {
  try {
    // Orden inverso a las FK: pedidos -> productos -> categorias
    db.exec(`
      DELETE FROM pedidos;
      DELETE FROM productos;
      DELETE FROM categorias;
      DELETE FROM sqlite_sequence WHERE name IN ('pedidos','productos','categorias');
    `);
    ok(res, { mensaje: "Todas las tablas fueron vaciadas" });
  } catch (e) {
    fail(res, 500, "Error al vaciar tablas: " + e.message);
  }
});

app.use((req, res) => fail(res, 404, "Ruta no encontrada"));

module.exports = app;
