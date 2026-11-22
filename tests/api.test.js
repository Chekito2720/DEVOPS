"use strict";

// Las pruebas usan SQLite en memoria y nunca modifican la base de datos real.
process.env.NODE_ENV = "test";

const request = require("supertest");
const app = require("../app");
const { resetDb } = require("../db");

const ADMIN = { email: "admin@demo.com", password: "Admin123!" };
let auth;
let adminId;

beforeAll(() => resetDb());

beforeAll(async () => {
  const response = await request(app).post("/api/auth/login").send(ADMIN);
  auth = { Authorization: `Bearer ${response.body.data.token}` };
  adminId = response.body.data.user.id;
});

function call(method, url, body) {
  const pending = request(app)[method](url).set(auth);
  return body === undefined ? pending : pending.send(body);
}

function expectSchema(response, statusCode, method, path) {
  expect(response.statusCode).toBe(statusCode);
  expect(response.body).toEqual(
    expect.objectContaining({
      statusCode,
      responseTime: expect.any(Number),
      request: method,
      path,
      timestamp: expect.any(String),
    })
  );
  expect(Number.isFinite(response.body.responseTime)).toBe(true);
  expect(response.body.responseTime).toBeGreaterThanOrEqual(0);
  expect(response.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  const payloadKeys = Object.keys(response.body).filter(
    (key) => key === "data" || key === "error"
  );
  expect(payloadKeys).toHaveLength(1);
  expect(Object.keys(response.body).sort()).toEqual(
    [
      "statusCode",
      "responseTime",
      "request",
      "path",
      "timestamp",
      payloadKeys[0],
    ].sort()
  );
}

function uniqueEmail(prefix = "qa") {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1e6)}@demo.com`;
}

describe("Health y esquema común", () => {
  test("GET /api/health responde 200 con todos los metadatos", async () => {
    const response = await request(app).get("/api/health");
    expectSchema(response, 200, "GET", "/api/health");
    expect(response.body.data.status).toBe("ok");
  });

  test("una ruta API inexistente responde 404 con el mismo esquema", async () => {
    const response = await request(app).get("/api/no-existe");
    expectSchema(response, 404, "GET", "/api/no-existe");
    expect(response.body).toHaveProperty("error", "Ruta no encontrada");
  });

  test("JSON malformado responde 400", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"mal":');
    expectSchema(response, 400, "POST", "/api/auth/login");
    expect(response.body.error).toBe("JSON invalido");
  });

  test("un cuerpo mayor al limite responde 413 con el mismo esquema", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send({ email: ADMIN.email, password: "x".repeat(110000) });

    expectSchema(response, 413, "POST", "/api/auth/login");
    expect(response.body.error).toBe("Cuerpo demasiado grande");
  });

  test("el path de respuesta excluye el query string", async () => {
    const response = await request(app).get("/api/health?probe=1");
    expect(response.body.path).toBe("/api/health");
  });
});

describe("Autenticacion JWT", () => {
  test("login sin cuerpo responde 400", async () => {
    const response = await request(app).post("/api/auth/login");
    expectSchema(response, 400, "POST", "/api/auth/login");
  });

  test.each([
    [{}, 400],
    [{ email: ADMIN.email }, 400],
    [{ email: "no-es-email", password: "secreto1" }, 401],
    [{ email: ADMIN.email, password: "incorrecta" }, 401],
    [{ email: "no@existe.com", password: "secreto1" }, 401],
  ])("login con %j responde %i", async (body, statusCode) => {
    const response = await request(app).post("/api/auth/login").send(body);
    expectSchema(response, statusCode, "POST", "/api/auth/login");
  });

  test("login correcto devuelve token y usuario sin hash", async () => {
    const response = await request(app).post("/api/auth/login").send(ADMIN);
    expectSchema(response, 200, "POST", "/api/auth/login");
    expect(response.body.data.token).toEqual(expect.any(String));
    expect(response.body.data.user.email).toBe(ADMIN.email);
    expect(response.body.data.user).not.toHaveProperty("password_hash");
  });

  test("el token JWT se firma explicitamente con HS256", async () => {
    const response = await request(app).post("/api/auth/login").send(ADMIN);
    const encodedHeader = response.body.data.token.split(".")[0];
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    expect(header.alg).toBe("HS256");
  });

  test.each(["/api/users", "/api/productos"])("%s sin token responde 401", async (url) => {
    const response = await request(app).get(url);
    expectSchema(response, 401, "GET", url);
    expect(response.body.error).toBe("Token requerido");
  });

  test("token invalido responde 401", async () => {
    const response = await request(app)
      .get("/api/users")
      .set("Authorization", "Bearer falso");
    expectSchema(response, 401, "GET", "/api/users");
    expect(response.body.error).toBe("Token invalido o expirado");
  });

  test("los intentos repetidos de login se limitan con 429", async () => {
    const email = uniqueEmail("rate-limit");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(app)
        .post("/api/auth/login")
        .send({ email, password: "incorrecta" });
      expect(response.statusCode).toBe(401);
    }

    const limited = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "incorrecta" });
    expectSchema(limited, 429, "POST", "/api/auth/login");
    expect(limited.headers["retry-after"]).toBeDefined();
  });
});

describe("CRUD usuarios", () => {
  let userId;
  const email = uniqueEmail();

  test("POST crea usuario (201)", async () => {
    const response = await call("post", "/api/users", {
      nombre: "Usuario QA",
      email,
      password: "secreto1",
    });
    expectSchema(response, 201, "POST", "/api/users");
    expect(response.body.data).toEqual(
      expect.objectContaining({ nombre: "Usuario QA", email, rol: "user" })
    );
    userId = response.body.data.id;
  });

  test.each([
    [{ email: "a@b.com", password: "secreto1" }],
    [{ nombre: "X", email: "no-es-email", password: "secreto1" }],
    [{ nombre: "X", email: ["a@b.com"], password: "secreto1" }],
    [{ nombre: "X", email: "x1@demo.com", password: "123" }],
    [{ nombre: "X", email: "x4@demo.com", password: 123456 }],
    [{ nombre: "X", email: "x6@demo.com", password: "a".repeat(73) }],
    [{ nombre: "X", email: "x2@demo.com", password: "secreto1", rol: "root" }],
    [{ nombre: "", email: "x3@demo.com", password: "secreto1" }],
    [{ nombre: 123, email: "x5@demo.com", password: "secreto1" }],
  ])("POST invalido %j responde 400", async (body) => {
    const response = await call("post", "/api/users", body);
    expectSchema(response, 400, "POST", "/api/users");
  });

  test("POST con email duplicado responde 409", async () => {
    const response = await call("post", "/api/users", {
      nombre: "Duplicado",
      email,
      password: "secreto1",
    });
    expectSchema(response, 409, "POST", "/api/users");
    expect(response.body.error).toBe("El email ya existe");
  });

  test("un usuario normal no puede administrar usuarios", async () => {
    const normalEmail = uniqueEmail("normal");
    const created = await call("post", "/api/users", {
      nombre: "Usuario normal",
      email: normalEmail,
      password: "secreto1",
    });
    expect(created.statusCode).toBe(201);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: normalEmail, password: "secreto1" });
    const normalAuth = { Authorization: `Bearer ${login.body.data.token}` };

    const usersResponse = await request(app).get("/api/users").set(normalAuth);
    expectSchema(usersResponse, 403, "GET", "/api/users");
    expect(usersResponse.body.error).toContain("administrador");

    const createResponse = await request(app)
      .post("/api/users")
      .set(normalAuth)
      .send({ nombre: "No permitido", email: uniqueEmail("no"), password: "secreto1" });
    expectSchema(createResponse, 403, "POST", "/api/users");
  });

  test("un cambio de rol invalida los tokens emitidos previamente", async () => {
    const email = uniqueEmail("revocar-rol");
    const created = await call("post", "/api/users", {
      nombre: "Rol revocable",
      email,
      password: "secreto1",
    });
    expect(created.statusCode).toBe(201);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "secreto1" });
    const oldToken = login.body.data.token;

    const updated = await call("put", `/api/users/${created.body.data.id}`, {
      rol: "admin",
    });
    expect(updated.statusCode).toBe(200);

    const response = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${oldToken}`);
    expectSchema(response, 401, "GET", "/api/users");
  });

  test("un cambio de password invalida los tokens emitidos previamente", async () => {
    const email = uniqueEmail("revocar-password");
    const created = await call("post", "/api/users", {
      nombre: "Password revocable",
      email,
      password: "secreto1",
    });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "secreto1" });
    const oldToken = login.body.data.token;

    const updated = await call("put", `/api/users/${created.body.data.id}`, {
      password: "nuevo123",
    });
    expect(updated.statusCode).toBe(200);

    const response = await request(app)
      .get("/api/productos")
      .set("Authorization", `Bearer ${oldToken}`);
    expectSchema(response, 401, "GET", "/api/productos");
  });

  test("eliminar un usuario invalida sus tokens emitidos previamente", async () => {
    const email = uniqueEmail("revocar-delete");
    const created = await call("post", "/api/users", {
      nombre: "Usuario eliminable",
      email,
      password: "secreto1",
    });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "secreto1" });
    const oldToken = login.body.data.token;

    const deleted = await call("delete", `/api/users/${created.body.data.id}`);
    expect(deleted.statusCode).toBe(200);

    const response = await request(app)
      .get("/api/productos")
      .set("Authorization", `Bearer ${oldToken}`);
    expectSchema(response, 401, "GET", "/api/productos");
  });

  test("GET lista responde 200 y no expone hashes", async () => {
    const response = await call("get", "/api/users");
    expectSchema(response, 200, "GET", "/api/users");
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data[0]).not.toHaveProperty("password_hash");
  });

  test("GET /:id responde 200", async () => {
    const response = await call("get", `/api/users/${userId}`);
    expectSchema(response, 200, "GET", `/api/users/${userId}`);
    expect(response.body.data.email).toBe(email);
  });

  test("GET /abc responde 400 y /999999 responde 404", async () => {
    const invalid = await call("get", "/api/users/abc");
    expectSchema(invalid, 400, "GET", "/api/users/abc");
    const missing = await call("get", "/api/users/999999");
    expectSchema(missing, 404, "GET", "/api/users/999999");
  });

  test("el administrador no puede quitarse sus propios permisos", async () => {
    const response = await call("put", `/api/users/${adminId}`, { rol: "user" });
    expectSchema(response, 400, "PUT", `/api/users/${adminId}`);
    expect(response.body.error).toContain("permisos");
  });

  test("PUT actualiza nombre, rol y password", async () => {
    const response = await call("put", `/api/users/${userId}`, {
      nombre: "Editado",
      rol: "admin",
      password: "nuevo123",
    });
    expectSchema(response, 200, "PUT", `/api/users/${userId}`);
    expect(response.body.data).toEqual(
      expect.objectContaining({ nombre: "Editado", rol: "admin" })
    );
  });

  test("PUT con email duplicado responde 409", async () => {
    const response = await call("put", `/api/users/${userId}`, {
      email: ADMIN.email,
    });
    expectSchema(response, 409, "PUT", `/api/users/${userId}`);
  });

  test("PUT con email invalido responde 400", async () => {
    const response = await call("put", `/api/users/${userId}`, { email: "malo" });
    expectSchema(response, 400, "PUT", `/api/users/${userId}`);
  });

  test("PUT inexistente responde 404", async () => {
    const response = await call("put", "/api/users/999999", { nombre: "X" });
    expectSchema(response, 404, "PUT", "/api/users/999999");
  });

  test("DELETE a si mismo responde 400", async () => {
    const response = await call("delete", `/api/users/${adminId}`);
    expectSchema(response, 400, "DELETE", `/api/users/${adminId}`);
    expect(response.body.error).toContain("tu propio usuario");
  });

  test("DELETE responde 200 y despues 404", async () => {
    const deleted = await call("delete", `/api/users/${userId}`);
    expectSchema(deleted, 200, "DELETE", `/api/users/${userId}`);
    expect(deleted.body.data.deleted).toBe(userId);

    const missing = await call("delete", `/api/users/${userId}`);
    expectSchema(missing, 404, "DELETE", `/api/users/${userId}`);
  });
});

describe("CRUD productos", () => {
  let productId;

  test("POST crea producto con stock y sin categoria (201)", async () => {
    const response = await call("post", "/api/productos", {
      nombre: "Producto QA",
      precio: 25,
      stock: 5,
    });
    expectSchema(response, 201, "POST", "/api/productos");
    expect(response.body.data).toEqual(
      expect.objectContaining({ nombre: "Producto QA", precio: 25, stock: 5 })
    );
    productId = response.body.data.id;
  });

  test("POST crea producto con categoria valida", async () => {
    const response = await call("post", "/api/productos", {
      nombre: "Con categoría",
      precio: 10,
      stock: 2,
      categoria_id: 1,
    });
    expectSchema(response, 201, "POST", "/api/productos");
    expect(response.body.data.categoria_id).toBe(1);
  });

  test.each([
    [{ precio: 10 }],
    [{ nombre: "X" }],
    [{ nombre: "X", precio: -1 }],
    [{ nombre: "X", precio: "caro" }],
    [{ nombre: "X", precio: 10, stock: 1.5 }],
    [{ nombre: "X", precio: 10, stock: 1e100 }],
    [{ nombre: "X", precio: 10, categoria_id: 999 }],
    [{ nombre: "X", precio: 10, categoria_id: "uno" }],
  ])("POST invalido %j responde 400", async (body) => {
    const response = await call("post", "/api/productos", body);
    expectSchema(response, 400, "POST", "/api/productos");
  });

  test("GET lista responde 200 e incluye stock", async () => {
    const response = await call("get", "/api/productos");
    expectSchema(response, 200, "GET", "/api/productos");
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data[0]).toHaveProperty("stock");
  });

  test("GET /:id responde 200", async () => {
    const response = await call("get", `/api/productos/${productId}`);
    expectSchema(response, 200, "GET", `/api/productos/${productId}`);
    expect(response.body.data.id).toBe(productId);
  });

  test("GET /abc responde 400 y /999999 responde 404", async () => {
    const invalid = await call("get", "/api/productos/abc");
    expectSchema(invalid, 400, "GET", "/api/productos/abc");
    const missing = await call("get", "/api/productos/999999");
    expectSchema(missing, 404, "GET", "/api/productos/999999");
  });

  test("PUT actualiza precio y stock", async () => {
    const response = await call("put", `/api/productos/${productId}`, {
      precio: 30,
      stock: 9,
    });
    expectSchema(response, 200, "PUT", `/api/productos/${productId}`);
    expect(response.body.data).toEqual(
      expect.objectContaining({ precio: 30, stock: 9 })
    );
  });

  test("PUT invalido responde 400 e inexistente responde 404", async () => {
    const invalid = await call("put", `/api/productos/${productId}`, { precio: -5 });
    expectSchema(invalid, 400, "PUT", `/api/productos/${productId}`);
    const missing = await call("put", "/api/productos/999999", { precio: 5 });
    expectSchema(missing, 404, "PUT", "/api/productos/999999");
  });

  test("DELETE responde 200 y despues 404", async () => {
    const deleted = await call("delete", `/api/productos/${productId}`);
    expectSchema(deleted, 200, "DELETE", `/api/productos/${productId}`);
    expect(deleted.body.data.eliminado).toBe(productId);

    const missing = await call("delete", `/api/productos/${productId}`);
    expectSchema(missing, 404, "DELETE", `/api/productos/${productId}`);
  });

  test("DELETE de un producto con pedidos responde 409", async () => {
    const response = await call("delete", "/api/productos/1");
    expectSchema(response, 409, "DELETE", "/api/productos/1");
    expect(response.body.error).toContain("pedidos");
  });
});

describe("Categorias y pedidos conservados", () => {
  test("categorias y pedidos requieren autenticacion", async () => {
    const categories = await request(app).get("/api/categorias");
    expectSchema(categories, 401, "GET", "/api/categorias");
    const orders = await request(app).get("/api/pedidos");
    expectSchema(orders, 401, "GET", "/api/pedidos");
  });

  test("GET /api/categorias devuelve el seed", async () => {
    const response = await call("get", "/api/categorias");
    expectSchema(response, 200, "GET", "/api/categorias");
    expect(response.body.data.length).toBeGreaterThanOrEqual(3);
  });

  test("POST categoria crea (201) y duplicado responde 409", async () => {
    const created = await call("post", "/api/categorias", { nombre: "Temporal" });
    expectSchema(created, 201, "POST", "/api/categorias");
    const duplicate = await call("post", "/api/categorias", { nombre: "Temporal" });
    expectSchema(duplicate, 409, "POST", "/api/categorias");
  });

  test("POST categoria sin nombre responde 400", async () => {
    const response = await call("post", "/api/categorias", {});
    expectSchema(response, 400, "POST", "/api/categorias");
  });

  test("DELETE categoria con productos responde 409", async () => {
    const response = await call("delete", "/api/categorias/1");
    expectSchema(response, 409, "DELETE", "/api/categorias/1");
  });

  test("DELETE categoria inexistente o invalida responde 404/400", async () => {
    const invalid = await call("delete", "/api/categorias/abc");
    expectSchema(invalid, 400, "DELETE", "/api/categorias/abc");
    const missing = await call("delete", "/api/categorias/999999");
    expectSchema(missing, 404, "DELETE", "/api/categorias/999999");
  });

  test("GET pedidos devuelve el seed", async () => {
    const response = await call("get", "/api/pedidos");
    expectSchema(response, 200, "GET", "/api/pedidos");
    expect(response.body.data.length).toBeGreaterThanOrEqual(3);
  });

  test("POST pedido crea (201)", async () => {
    const response = await call("post", "/api/pedidos", {
      producto_id: 1,
      cantidad: 2,
    });
    expectSchema(response, 201, "POST", "/api/pedidos");
    expect(response.body.data.cantidad).toBe(2);
  });

  test.each([
    [{ cantidad: 1 }],
    [{ producto_id: 1, cantidad: 0 }],
    [{ producto_id: 1, cantidad: -3 }],
    [{ producto_id: 1, cantidad: 2.5 }],
    [{ producto_id: 1, cantidad: 1e100 }],
    [{ producto_id: 999, cantidad: 1 }],
  ])("POST pedido invalido %j responde 400", async (body) => {
    const response = await call("post", "/api/pedidos", body);
    expectSchema(response, 400, "POST", "/api/pedidos");
  });
});

describe("Administracion de base de datos", () => {
  test("GET /api/db/backup genera un respaldo (200)", async () => {
    const response = await call("get", "/api/db/backup");
    expectSchema(response, 200, "GET", "/api/db/backup");
    expect(response.body.data.backup).toMatch(/backup-\d+\.db$/);
  });

  test("DELETE /api/db/clear vacia categorias, productos y pedidos", async () => {
    const response = await call("delete", "/api/db/clear");
    expectSchema(response, 200, "DELETE", "/api/db/clear");

    const categories = await call("get", "/api/categorias");
    const products = await call("get", "/api/productos");
    const orders = await call("get", "/api/pedidos");
    expect(categories.body.data).toHaveLength(0);
    expect(products.body.data).toHaveLength(0);
    expect(orders.body.data).toHaveLength(0);
  });

  test("los endpoints administrativos requieren token", async () => {
    const backup = await request(app).get("/api/db/backup");
    expectSchema(backup, 401, "GET", "/api/db/backup");
    const clear = await request(app).delete("/api/db/clear");
    expectSchema(clear, 401, "DELETE", "/api/db/clear");
  });
});
