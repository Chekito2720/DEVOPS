// Pruebas unitarias de la API con Jest + Supertest
// Se ejecutan contra SQLite en memoria (NODE_ENV=test), sin tocar la BD real
process.env.NODE_ENV = "test";

const request = require("supertest");
const app = require("../app");
const { resetDb } = require("../db");

// Cada prueba arranca con la BD limpia y con el seed cargado
beforeEach(() => resetDb());

describe("Health", () => {
  test("GET /api/health responde 200 con status ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.statusCode).toBe(200);
    expect(res.body.data.status).toBe("ok");
  });
});

describe("Categorias", () => {
  test("GET /api/categorias responde 200 y data como arreglo con el seed", async () => {
    const res = await request(app).get("/api/categorias");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
  });

  test("POST /api/categorias crea una categoria valida (201)", async () => {
    const res = await request(app).post("/api/categorias").send({ nombre: "Bebidas" });
    expect(res.statusCode).toBe(201);
    expect(res.body.data).toHaveProperty("id");
    expect(res.body.data.nombre).toBe("Bebidas");
  });

  test("POST /api/categorias falla si falta el nombre (400)", async () => {
    const res = await request(app).post("/api/categorias").send({});
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  test("POST /api/categorias falla si el nombre no es texto (400)", async () => {
    const res = await request(app).post("/api/categorias").send({ nombre: 12345 });
    expect(res.statusCode).toBe(400);
  });

  test("POST /api/categorias con nombre duplicado responde 409", async () => {
    const res = await request(app).post("/api/categorias").send({ nombre: "Electronica" });
    expect(res.statusCode).toBe(409);
  });

  test("DELETE /api/categorias/:id con id inexistente responde 404", async () => {
    const res = await request(app).delete("/api/categorias/9999");
    expect(res.statusCode).toBe(404);
  });

  test("DELETE /api/categorias/abc con id no numerico responde 400", async () => {
    const res = await request(app).delete("/api/categorias/abc");
    expect(res.statusCode).toBe(400);
  });

  test("DELETE /api/categorias/:id con productos asociados responde 409", async () => {
    // La categoria 1 (Electronica) tiene productos del seed
    const res = await request(app).delete("/api/categorias/1");
    expect(res.statusCode).toBe(409);
  });

  test("DELETE /api/categorias/:id elimina una categoria sin productos (200)", async () => {
    const creada = await request(app).post("/api/categorias").send({ nombre: "Temporal" });
    const res = await request(app).delete(`/api/categorias/${creada.body.data.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.eliminado).toBe(creada.body.data.id);
  });
});

describe("Productos", () => {
  test("GET /api/productos responde 200 e incluye la categoria (JOIN)", async () => {
    const res = await request(app).get("/api/productos");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(6);
    expect(res.body.data[0]).toHaveProperty("categoria");
  });

  test("POST /api/productos crea un producto valido (201)", async () => {
    const res = await request(app)
      .post("/api/productos")
      .send({ nombre: "Teclado", precio: 350.5, categoria_id: 1 });
    expect(res.statusCode).toBe(201);
    expect(res.body.data).toHaveProperty("id");
    expect(res.body.data.precio).toBe(350.5);
  });

  test("POST /api/productos con campos faltantes responde 400", async () => {
    const res = await request(app).post("/api/productos").send({ nombre: "Taco" });
    expect(res.statusCode).toBe(400);
  });

  test("POST /api/productos con precio negativo responde 400", async () => {
    const res = await request(app)
      .post("/api/productos")
      .send({ nombre: "Taco", precio: -5, categoria_id: 1 });
    expect(res.statusCode).toBe(400);
  });

  test("POST /api/productos con precio como texto responde 400", async () => {
    const res = await request(app)
      .post("/api/productos")
      .send({ nombre: "Taco", precio: "caro", categoria_id: 1 });
    expect(res.statusCode).toBe(400);
  });

  test("POST /api/productos con categoria_id inexistente responde 400 (FK invalida)", async () => {
    const res = await request(app)
      .post("/api/productos")
      .send({ nombre: "Taco", precio: 25, categoria_id: 999 });
    expect(res.statusCode).toBe(400);
  });

  test("DELETE /api/productos/:id con id inexistente responde 404", async () => {
    const res = await request(app).delete("/api/productos/9999");
    expect(res.statusCode).toBe(404);
  });

  test("DELETE /api/productos/xyz con id no numerico responde 400", async () => {
    const res = await request(app).delete("/api/productos/xyz");
    expect(res.statusCode).toBe(400);
  });

  test("DELETE /api/productos/:id con pedidos asociados responde 409", async () => {
    // El producto 1 (Laptop) tiene pedidos del seed
    const res = await request(app).delete("/api/productos/1");
    expect(res.statusCode).toBe(409);
  });
});

describe("Pedidos", () => {
  test("GET /api/pedidos responde 200 con pedidos del seed", async () => {
    const res = await request(app).get("/api/pedidos");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
  });

  test("POST /api/pedidos crea un pedido valido (201)", async () => {
    const res = await request(app).post("/api/pedidos").send({ producto_id: 1, cantidad: 2 });
    expect(res.statusCode).toBe(201);
    expect(res.body.data).toHaveProperty("id");
    expect(res.body.data.cantidad).toBe(2);
  });

  test("POST /api/pedidos con cantidad 0 responde 400", async () => {
    const res = await request(app).post("/api/pedidos").send({ producto_id: 1, cantidad: 0 });
    expect(res.statusCode).toBe(400);
  });

  test("POST /api/pedidos con cantidad negativa responde 400", async () => {
    const res = await request(app).post("/api/pedidos").send({ producto_id: 1, cantidad: -3 });
    expect(res.statusCode).toBe(400);
  });

  test("POST /api/pedidos con cantidad decimal responde 400", async () => {
    const res = await request(app).post("/api/pedidos").send({ producto_id: 1, cantidad: 2.5 });
    expect(res.statusCode).toBe(400);
  });

  test("POST /api/pedidos con producto_id inexistente responde 400 (FK invalida)", async () => {
    const res = await request(app).post("/api/pedidos").send({ producto_id: 999, cantidad: 1 });
    expect(res.statusCode).toBe(400);
  });

  test("POST /api/pedidos con campos faltantes responde 400", async () => {
    const res = await request(app).post("/api/pedidos").send({ cantidad: 1 });
    expect(res.statusCode).toBe(400);
  });
});

describe("Administracion de BD", () => {
  test("GET /api/db/backup genera un respaldo (200)", async () => {
    const res = await request(app).get("/api/db/backup");
    expect(res.statusCode).toBe(200);
    expect(res.body.data.backup).toMatch(/backup-\d+\.db$/);
  });

  test("DELETE /api/db/clear vacia todas las tablas (200)", async () => {
    const res = await request(app).delete("/api/db/clear");
    expect(res.statusCode).toBe(200);

    const cat = await request(app).get("/api/categorias");
    const prod = await request(app).get("/api/productos");
    const ped = await request(app).get("/api/pedidos");
    expect(cat.body.data).toHaveLength(0);
    expect(prod.body.data).toHaveLength(0);
    expect(ped.body.data).toHaveLength(0);
  });
});

describe("Rutas inexistentes", () => {
  test("GET de una ruta que no existe responde 404", async () => {
    const res = await request(app).get("/api/no-existe");
    expect(res.statusCode).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});
