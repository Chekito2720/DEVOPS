"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { db, BACKUP_DIR } = require("./db");
const { sign, requireAuth, requireAdmin } = require("./auth");
const { ok, fail } = require("./responses");
const { metricsMiddleware, log, dbSpan, dbSpanAsync } = require("./telemetry");

const app = express();
const USER_COLUMNS = "id, nombre, email, rol";
const DUMMY_PASSWORD_HASH =
  "$2b$10$nOID7tlJfIErIBY.bsaiC.S3y7tjLxH64RdB.syqYxvMpFl4o04n6";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_IP_FAILURES = 20;
const LOGIN_MAX_ACCOUNT_FAILURES = 5;
const MAX_PASSWORD_BYTES = 72;
const loginFailures = new Map();

function accountFingerprint(email) {
  return crypto
    .createHash("sha256")
    .update(String(email).toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

function getAttemptState(key, now = Date.now()) {
  const state = loginFailures.get(key);
  if (!state || state.resetAt <= now) {
    loginFailures.delete(key);
    return null;
  }
  return state;
}

function getLoginLimit(req, email) {
  const now = Date.now();
  const keys = [
    { key: `ip:${req.ip || req.socket.remoteAddress || "unknown"}`, limit: LOGIN_MAX_IP_FAILURES },
    { key: `account:${accountFingerprint(email)}`, limit: LOGIN_MAX_ACCOUNT_FAILURES },
  ];

  for (const entry of keys) {
    const state = getAttemptState(entry.key, now);
    if (state && state.count >= entry.limit) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(1, Math.ceil((state.resetAt - now) / 1000)),
      };
    }
  }
  return { limited: false, retryAfterSeconds: 0 };
}

function recordLoginFailure(req, email) {
  const now = Date.now();
  const keys = [
    `ip:${req.ip || req.socket.remoteAddress || "unknown"}`,
    `account:${accountFingerprint(email)}`,
  ];

  for (const key of keys) {
    const state = getAttemptState(key, now) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    state.count += 1;
    loginFailures.set(key, state);
  }
}

function clearAccountLoginFailures(email) {
  loginFailures.delete(`account:${accountFingerprint(email)}`);
}

function passwordByteLength(password) {
  return Buffer.byteLength(String(password), "utf8");
}

const loginCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, state] of loginFailures) {
    if (state.resetAt <= now) loginFailures.delete(key);
  }
}, LOGIN_WINDOW_MS);
loginCleanupTimer.unref();

app.disable("x-powered-by");

// Metadatos de respuesta y telemetría para todas las peticiones HTTP.
app.use((req, res, next) => {
  req.startedAtNs = process.hrtime.bigint();
  next();
});
app.use(metricsMiddleware);
app.use(express.json({ limit: "100kb" }));

function parseId(raw) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isUniqueConstraint(error) {
  return String(error && error.message).includes("UNIQUE");
}

function isForeignKeyConstraint(error) {
  return String(error && error.message).includes("FOREIGN KEY");
}

function findCategory(categoryId) {
  return dbSpan("categorias.get", () =>
    db.prepare("SELECT id FROM categorias WHERE id = ?").get(categoryId)
  );
}

function findProduct(productId) {
  return dbSpan("productos.get", () =>
    db
      .prepare(
        `SELECT p.id, p.nombre, p.precio, p.stock, p.categoria_id, c.nombre AS categoria
         FROM productos p
         LEFT JOIN categorias c ON c.id = p.categoria_id
         WHERE p.id = ?`
      )
      .get(productId)
  );
}

// ---------- Publico ----------

app.get("/api/health", (req, res) => {
  try {
    dbSpan("health.check", () => db.prepare("SELECT 1 AS healthy").get());
    return ok(req, res, {
      status: "ok",
      version: process.env.APP_VERSION || "unknown",
      autor: "Sergio Abdiel Gonzalez Bravo",
      fecha: new Date().toISOString(),
    });
  } catch (error) {
    log("ERROR", error.message, { route: "/api/health" });
    return fail(req, res, 503, "Servicio no disponible");
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};

  if (
    typeof email !== "string" ||
    !email.trim() ||
    typeof password !== "string" ||
    !password
  ) {
    return fail(req, res, 400, "email y password son requeridos");
  }
  if (email.length > 254 || passwordByteLength(password) > MAX_PASSWORD_BYTES) {
    return fail(req, res, 400, "email o password exceden la longitud permitted");
  }

  const normalizedEmail = email.trim().toLowerCase();
  const limit = getLoginLimit(req, normalizedEmail);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    log("WARN", "login bloqueado por limite de intentos", {
      route: "/api/auth/login",
      account: accountFingerprint(normalizedEmail),
    });
    return fail(req, res, 429, "Demasiados intentos de inicio de sesion");
  }

  const user = dbSpan("users.byEmail", () =>
    db.prepare("SELECT * FROM users WHERE email = ?").get(normalizedEmail)
  );

  // Se ejecuta bcrypt tambien para usuarios inexistentes para reducir la
  // diferencia de temporizacion y evitar enumeracion de cuentas.
  const passwordMatches = await bcrypt.compare(
    password,
    user ? user.password_hash : DUMMY_PASSWORD_HASH
  );

  if (!user || !passwordMatches) {
    recordLoginFailure(req, normalizedEmail);
    log("WARN", "login fallido", {
      account: accountFingerprint(normalizedEmail),
      route: "/api/auth/login",
    });
    return fail(req, res, 401, "Credenciales invalidas - DEMO A");
  }

  clearAccountLoginFailures(normalizedEmail);
  log("INFO", "login exitoso", { user_id: user.id, route: "/api/auth/login" });
  return ok(req, res, {
    token: sign(user),
    user: {
      id: user.id,
      nombre: user.nombre,
      email: user.email,
      rol: user.rol,
    },
  });
});

// ---------- Usuarios (JWT) ----------

function validateUser(body, { partial = false } = {}) {
  if (!partial && (!body.nombre || !body.email || !body.password)) {
    return "nombre, email y password son requeridos";
  }
  if (
    body.nombre !== undefined &&
    (typeof body.nombre !== "string" ||
      !body.nombre.trim() ||
      body.nombre.length > 120)
  ) {
    return "nombre invalido";
  }
  if (
    body.email !== undefined &&
    (typeof body.email !== "string" ||
      body.email.length > 254 ||
      !/^\S+@\S+\.\S+$/.test(body.email.trim()))
  ) {
    return "email invalido";
  }
  if (
    body.password !== undefined &&
    (typeof body.password !== "string" ||
      body.password.length < 6 ||
      passwordByteLength(body.password) > MAX_PASSWORD_BYTES)
  ) {
    return "password debe tener entre 6 y 72 bytes";
  }
  if (body.rol !== undefined && !["admin", "user"].includes(body.rol)) {
    return "rol invalido";
  }
  return null;
}

app.get("/api/users", requireAuth, requireAdmin, (req, res) => {
  const users = dbSpan("users.list", () =>
    db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY id`).all()
  );
  return ok(req, res, users);
});

app.get("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return fail(req, res, 400, "id invalido");

  const user = dbSpan("users.get", () =>
    db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id)
  );
  return user ? ok(req, res, user) : fail(req, res, 404, "Usuario no encontrado");
});

app.post("/api/users", requireAuth, requireAdmin, async (req, res) => {
  const body = req.body || {};
  const validationError = validateUser(body);
  if (validationError) return fail(req, res, 400, validationError);

  const nombre = body.nombre.trim();
  const email = body.email.trim().toLowerCase();
  const rol = body.rol || "user";

  try {
    const passwordHash = await bcrypt.hash(body.password, 10);
    const info = dbSpan("users.insert", () =>
      db
        .prepare(
          "INSERT INTO users (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)"
        )
        .run(nombre, email, passwordHash, rol)
    );

    log("INFO", "audit: usuario creado", {
      actor_id: req.user.id,
      target_user_id: Number(info.lastInsertRowid),
      action: "user.create",
    });
    return ok(
      req,
      res,
      { id: Number(info.lastInsertRowid), nombre, email, rol },
      201
    );
  } catch (error) {
    if (isUniqueConstraint(error)) return fail(req, res, 409, "El email ya existe");
    log("ERROR", error.message, { route: "/api/users" });
    return fail(req, res, 500, "Error interno");
  }
});

app.put("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return fail(req, res, 400, "id invalido");

  const current = dbSpan("users.getForUpdate", () =>
    db.prepare("SELECT * FROM users WHERE id = ?").get(id)
  );
  if (!current) return fail(req, res, 404, "Usuario no encontrado");

  const body = req.body || {};
  const validationError = validateUser(body, { partial: true });
  if (validationError) return fail(req, res, 400, validationError);
  if (id === Number(req.user.id) && body.rol && body.rol !== "admin") {
    return fail(req, res, 400, "No puedes quitarte tus permisos de administrador");
  }

  const roleChanged = body.rol !== undefined && body.rol !== current.rol;
  const passwordChanged = body.password !== undefined;
  const tokenVersionIncrement = roleChanged || passwordChanged ? 1 : 0;

  const nombre = body.nombre === undefined ? current.nombre : body.nombre.trim();
  const email =
    body.email === undefined ? current.email : body.email.trim().toLowerCase();
  const rol = body.rol === undefined ? current.rol : body.rol;
  const passwordHash =
    body.password === undefined
      ? current.password_hash
      : await bcrypt.hash(body.password, 10);

  try {
    dbSpan("users.update", () =>
      db
        .prepare(
          `UPDATE users
           SET nombre = ?, email = ?, rol = ?, password_hash = ?,
               token_version = token_version + ?
           WHERE id = ?`
        )
        .run(nombre, email, rol, passwordHash, tokenVersionIncrement, id)
    );

    log("INFO", "audit: usuario actualizado", {
      actor_id: req.user.id,
      target_user_id: id,
      action: "user.update",
      role_changed: roleChanged,
      password_changed: passwordChanged,
    });
    return ok(req, res, { id, nombre, email, rol });
  } catch (error) {
    if (isUniqueConstraint(error)) return fail(req, res, 409, "El email ya existe");
    log("ERROR", error.message, { route: "/api/users/:id" });
    return fail(req, res, 500, "Error interno");
  }
});

app.delete("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return fail(req, res, 400, "id invalido");
  if (id === Number(req.user.id)) {
    return fail(req, res, 400, "No puedes eliminar tu propio usuario");
  }

  const info = dbSpan("users.delete", () =>
    db.prepare("DELETE FROM users WHERE id = ?").run(id)
  );
  if (!info.changes) return fail(req, res, 404, "Usuario no encontrado");

  log("INFO", "audit: usuario eliminado", {
    actor_id: req.user.id,
    target_user_id: id,
    action: "user.delete",
  });
  return ok(req, res, { deleted: id });
});

// ---------- Productos (JWT) ----------

function validateProduct(body, { partial = false } = {}) {
  if (!partial && (body.nombre === undefined || body.precio === undefined)) {
    return "nombre y precio son requeridos";
  }
  if (
    body.nombre !== undefined &&
    (typeof body.nombre !== "string" || !body.nombre.trim())
  ) {
    return "nombre invalido";
  }
  if (
    body.precio !== undefined &&
    (typeof body.precio !== "number" || !Number.isFinite(body.precio) || body.precio < 0)
  ) {
    return "precio debe ser un numero mayor o igual a 0";
  }
  if (
    body.stock !== undefined &&
    (!Number.isSafeInteger(body.stock) || body.stock < 0)
  ) {
    return "stock debe ser un entero seguro mayor o igual a 0";
  }
  if (
    body.categoria_id !== undefined &&
    body.categoria_id !== null &&
    (!Number.isSafeInteger(body.categoria_id) || body.categoria_id <= 0)
  ) {
    return "categoria_id debe ser un entero seguro positivo o null";
  }
  return null;
}

app.get("/api/productos", requireAuth, (req, res) => {
  const products = dbSpan("productos.list", () =>
    db
      .prepare(
        `SELECT p.id, p.nombre, p.precio, p.stock, p.categoria_id, c.nombre AS categoria
         FROM productos p
         LEFT JOIN categorias c ON c.id = p.categoria_id
         ORDER BY p.id`
      )
      .all()
  );
  return ok(req, res, products);
});

app.get("/api/productos/:id", requireAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return fail(req, res, 400, "id invalido");

  const product = findProduct(id);
  return product
    ? ok(req, res, product)
    : fail(req, res, 404, "Producto no encontrado");
});

app.post("/api/productos", requireAuth, (req, res) => {
  const body = req.body || {};
  const validationError = validateProduct(body);
  if (validationError) return fail(req, res, 400, validationError);

  const categoryId = body.categoria_id ?? null;
  if (categoryId !== null && !findCategory(categoryId)) {
    return fail(req, res, 400, "categoria_id no existe");
  }

  try {
    const info = dbSpan("productos.insert", () =>
      db
        .prepare(
          "INSERT INTO productos (nombre, precio, stock, categoria_id) VALUES (?, ?, ?, ?)"
        )
        .run(body.nombre.trim(), body.precio, body.stock ?? 0, categoryId)
    );

    return ok(
      req,
      res,
      {
        id: Number(info.lastInsertRowid),
        nombre: body.nombre.trim(),
        precio: body.precio,
        stock: body.stock ?? 0,
        categoria_id: categoryId,
      },
      201
    );
  } catch (error) {
    if (isForeignKeyConstraint(error)) {
      return fail(req, res, 400, "categoria_id no existe");
    }
    log("ERROR", error.message, { route: "/api/productos" });
    return fail(req, res, 500, "Error interno");
  }
});

app.put("/api/productos/:id", requireAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return fail(req, res, 400, "id invalido");

  const current = dbSpan("productos.getForUpdate", () =>
    db.prepare("SELECT * FROM productos WHERE id = ?").get(id)
  );
  if (!current) return fail(req, res, 404, "Producto no encontrado");

  const body = req.body || {};
  const validationError = validateProduct(body, { partial: true });
  if (validationError) return fail(req, res, 400, validationError);

  const nombre = body.nombre === undefined ? current.nombre : body.nombre.trim();
  const precio = body.precio === undefined ? current.precio : body.precio;
  const stock = body.stock === undefined ? current.stock : body.stock;
  const categoryId =
    body.categoria_id === undefined ? current.categoria_id : body.categoria_id;

  if (categoryId !== null && !findCategory(categoryId)) {
    return fail(req, res, 400, "categoria_id no existe");
  }

  try {
    dbSpan("productos.update", () =>
      db
        .prepare(
          "UPDATE productos SET nombre = ?, precio = ?, stock = ?, categoria_id = ? WHERE id = ?"
        )
        .run(nombre, precio, stock, categoryId, id)
    );

    return ok(req, res, {
      id,
      nombre,
      precio,
      stock,
      categoria_id: categoryId,
    });
  } catch (error) {
    if (isForeignKeyConstraint(error)) {
      return fail(req, res, 400, "categoria_id no existe");
    }
    log("ERROR", error.message, { route: "/api/productos/:id" });
    return fail(req, res, 500, "Error interno");
  }
});

app.delete("/api/productos/:id", requireAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return fail(req, res, 400, "id invalido");

  try {
    const info = dbSpan("productos.delete", () =>
      db.prepare("DELETE FROM productos WHERE id = ?").run(id)
    );
    return info.changes
      ? ok(req, res, { eliminado: id })
      : fail(req, res, 404, "Producto no encontrado");
  } catch (error) {
    if (isForeignKeyConstraint(error)) {
      return fail(req, res, 409, "No se puede eliminar: tiene pedidos asociados");
    }
    log("ERROR", error.message, { route: "/api/productos/:id" });
    return fail(req, res, 500, "Error interno");
  }
});

// ---------- Categorias y pedidos (funcionalidad previa conservada) ----------

app.get("/api/categorias", requireAuth, (req, res) => {
  const categories = dbSpan("categorias.list", () =>
    db.prepare("SELECT * FROM categorias ORDER BY id").all()
  );
  return ok(req, res, categories);
});

app.post("/api/categorias", requireAuth, (req, res) => {
  const { nombre } = req.body || {};
  if (typeof nombre !== "string" || !nombre.trim()) {
    return fail(req, res, 400, "nombre es requerido y debe ser texto no vacio");
  }

  try {
    const info = dbSpan("categorias.insert", () =>
      db.prepare("INSERT INTO categorias (nombre) VALUES (?)").run(nombre.trim())
    );
    const category = dbSpan("categorias.get", () =>
      db.prepare("SELECT * FROM categorias WHERE id = ?").get(info.lastInsertRowid)
    );
    return ok(req, res, category, 201);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      return fail(req, res, 409, "La categoria ya existe");
    }
    log("ERROR", error.message, { route: "/api/categorias" });
    return fail(req, res, 500, "Error interno");
  }
});

app.delete("/api/categorias/:id", requireAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return fail(req, res, 400, "id debe ser un numero entero valido");

  try {
    const info = dbSpan("categorias.delete", () =>
      db.prepare("DELETE FROM categorias WHERE id = ?").run(id)
    );
    return info.changes
      ? ok(req, res, { eliminado: id })
      : fail(req, res, 404, "Categoria no encontrada");
  } catch (error) {
    if (isForeignKeyConstraint(error)) {
      return fail(req, res, 409, "No se puede eliminar: tiene productos asociados");
    }
    log("ERROR", error.message, { route: "/api/categorias/:id" });
    return fail(req, res, 500, "Error al eliminar categoria");
  }
});

app.get("/api/pedidos", requireAuth, (req, res) => {
  const orders = dbSpan("pedidos.list", () =>
    db
      .prepare(
        `SELECT pe.id, pe.producto_id, pr.nombre AS producto, pe.cantidad, pe.fecha
         FROM pedidos pe
         JOIN productos pr ON pr.id = pe.producto_id
         ORDER BY pe.id`
      )
      .all()
  );
  return ok(req, res, orders);
});

app.post("/api/pedidos", requireAuth, (req, res) => {
  const { producto_id: productId, cantidad } = req.body || {};

  if (!Number.isSafeInteger(productId) || productId <= 0) {
    return fail(req, res, 400, "producto_id debe ser un entero seguro positivo");
  }
  const product = dbSpan("productos.exists", () =>
    db.prepare("SELECT id FROM productos WHERE id = ?").get(productId)
  );
  if (!product) return fail(req, res, 400, "producto_id no existe");
  if (!Number.isSafeInteger(cantidad) || cantidad <= 0) {
    return fail(req, res, 400, "cantidad debe ser un entero seguro mayor a 0");
  }

  try {
    const info = dbSpan("pedidos.insert", () =>
      db.prepare("INSERT INTO pedidos (producto_id, cantidad) VALUES (?, ?)").run(
        productId,
        cantidad
      )
    );
    const order = dbSpan("pedidos.get", () =>
      db
        .prepare(
          `SELECT pe.id, pe.producto_id, pr.nombre AS producto, pe.cantidad, pe.fecha
           FROM pedidos pe
           JOIN productos pr ON pr.id = pe.producto_id
           WHERE pe.id = ?`
        )
        .get(info.lastInsertRowid)
    );
    return ok(req, res, order, 201);
  } catch (error) {
    if (isForeignKeyConstraint(error)) {
      return fail(req, res, 400, "producto_id no existe");
    }
    log("ERROR", error.message, { route: "/api/pedidos" });
    return fail(req, res, 500, "Error interno");
  }
});

// ---------- Administracion de base de datos ----------

app.get("/api/db/backup", requireAuth, requireAdmin, async (req, res) => {
  const file = path.join(BACKUP_DIR, `backup-${Date.now()}.db`);
  try {
    await dbSpanAsync("db.backup", () => db.backup(file));
    log("INFO", "audit: respaldo creado", {
      actor_id: req.user.id,
      action: "db.backup",
      backup: path.basename(file),
    });
    return ok(req, res, { backup: path.basename(file) });
  } catch (error) {
    log("ERROR", error.message, { route: "/api/db/backup" });
    return fail(req, res, 500, "Error al crear backup");
  }
});

app.delete("/api/db/clear", requireAuth, requireAdmin, async (req, res) => {
  const backupFile = path.join(BACKUP_DIR, `pre-clear-${Date.now()}.db`);
  try {
    await dbSpanAsync("db.backupBeforeClear", () => db.backup(backupFile));
    dbSpan("db.clear", () => {
      db.transaction(() => {
        db.exec(`
          DELETE FROM pedidos;
          DELETE FROM productos;
          DELETE FROM categorias;
          DELETE FROM sqlite_sequence WHERE name IN ('pedidos', 'productos', 'categorias');
        `);
      })();
    });
    log("WARN", "audit: datos operativos vaciados", {
      actor_id: req.user.id,
      action: "db.clear",
      backup: path.basename(backupFile),
    });
    return ok(req, res, {
      mensaje: "Categorias, productos y pedidos fueron vaciados",
      backup: path.basename(backupFile),
    });
  } catch (error) {
    log("ERROR", error.message, { route: "/api/db/clear" });
    return fail(req, res, 500, "Error al vaciar tablas");
  }
});

// ---------- Frontend, 404 y errores ----------

app.use("/api", (req, res) => fail(req, res, 404, "Ruta no encontrada"));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res) => fail(req, res, 404, "Ruta no encontrada"));

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  if (error && error.type === "entity.parse.failed") {
    return fail(req, res, 400, "JSON invalido");
  }

  const errorStatus = Number(error && (error.status || error.statusCode));
  if (errorStatus === 413) {
    return fail(req, res, 413, "Cuerpo demasiado grande");
  }
  if (errorStatus === 415) {
    return fail(req, res, 415, "Content-Type no soportado");
  }
  if (errorStatus >= 400 && errorStatus < 500) {
    return fail(req, res, errorStatus, "Solicitud invalida");
  }

  log("ERROR", error && error.message ? error.message : "Error desconocido", {
    route: req.originalUrl,
  });
  return fail(req, res, 500, "Error interno");
});

module.exports = app;
