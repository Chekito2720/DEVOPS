"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const projectRoot = path.join(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-migration-test-"));
const dbPath = path.join(dataDir, "app.db");

function createLegacyDatabase() {
  const legacy = new Database(dbPath);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(`
    CREATE TABLE categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL UNIQUE
    );

    CREATE TABLE productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      precio REAL NOT NULL CHECK (precio >= 0),
      categoria_id INTEGER NOT NULL REFERENCES categorias(id) ON DELETE RESTRICT
    );

    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,
      cantidad INTEGER NOT NULL CHECK (cantidad > 0),
      fecha TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'user' CHECK (rol IN ('admin', 'user'))
    );
  `);

  legacy
    .prepare(
      "INSERT INTO users (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)"
    )
    .run("Administrador", "admin@demo.com", "legacy-hash", "admin");

  legacy
    .prepare("INSERT INTO categorias (nombre) VALUES (?), (?), (?)")
    .run("Electronica", "Hogar", "Alimentos");
  legacy
    .prepare(
      "INSERT INTO productos (nombre, precio, categoria_id) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)"
    )
    .run("Laptop", 15000, 1, "Audifonos", 799.99, 1, "Mouse", 250, 1);
  legacy.prepare("DELETE FROM productos WHERE id = 3").run();
  legacy
    .prepare("INSERT INTO pedidos (producto_id, cantidad) VALUES (?, ?), (?, ?)")
    .run(1, 1, 2, 3);
  legacy.close();
}

beforeAll(() => {
  createLegacyDatabase();

  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "const { db } = require('./db'); db.close();",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATA_DIR: dataDir,
        JWT_SECRET: "migration-test-secret-with-at-least-32-characters",
        ADMIN_EMAIL: "admin@demo.com",
        ADMIN_PASSWORD: "Migration123!",
      },
    }
  );

  if (child.status !== 0) {
    throw new Error(
      `La migracion fallo (${child.status}): ${child.stderr || child.stdout}`
    );
  }
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("migracion preserva categorias, productos y pedidos legacy", () => {
  const migrated = new Database(dbPath, { readonly: true });

  expect(migrated.prepare("SELECT COUNT(*) AS count FROM categorias").get().count).toBe(3);
  expect(migrated.prepare("SELECT COUNT(*) AS count FROM productos").get().count).toBe(2);
  expect(migrated.prepare("SELECT COUNT(*) AS count FROM pedidos").get().count).toBe(2);
  expect(
    migrated
      .prepare("SELECT id, nombre, precio, stock, categoria_id FROM productos ORDER BY id")
      .all()
  ).toEqual([
    { id: 1, nombre: "Laptop", precio: 15000, stock: 0, categoria_id: 1 },
    { id: 2, nombre: "Audifonos", precio: 799.99, stock: 0, categoria_id: 1 },
  ]);
  expect(
    migrated
      .prepare("SELECT producto_id, cantidad FROM pedidos ORDER BY id")
      .all()
  ).toEqual([
    { producto_id: 1, cantidad: 1 },
    { producto_id: 2, cantidad: 3 },
  ]);
  expect(migrated.pragma("foreign_key_check")).toEqual([]);

  const productColumns = migrated.pragma("table_info(productos)");
  const stockColumn = productColumns.find((column) => column.name === "stock");
  const categoryColumn = productColumns.find(
    (column) => column.name === "categoria_id"
  );

  expect(stockColumn).toEqual(
    expect.objectContaining({ notnull: 1, dflt_value: "0" })
  );
  expect(categoryColumn.notnull).toBe(0);
  expect(
    migrated.prepare("SELECT COUNT(*) AS count FROM productos WHERE stock = 0").get().count
  ).toBe(2);
  expect(
    migrated.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'productos'").get().seq
  ).toBe(3);
  expect(migrated.prepare("SELECT COUNT(*) AS count FROM users").get().count).toBe(1);
  expect(
    migrated.pragma("table_info(users)").some((column) => column.name === "token_version")
  ).toBe(true);
  expect(
    migrated.prepare("SELECT token_version FROM users WHERE email = ?").get("admin@demo.com")
      .token_version
  ).toBe(0);

  migrated.close();

  const writable = new Database(dbPath);
  const inserted = writable
    .prepare(
      "INSERT INTO productos (nombre, precio, stock, categoria_id) VALUES (?, ?, ?, ?)"
    )
    .run("Siguiente producto", 10, 1, 1);
  expect(inserted.lastInsertRowid).toBe(4);
  writable.close();
});

test("la migracion crea un respaldo previo sin alterar el original", () => {
  const backups = fs
    .readdirSync(path.join(dataDir, "backups"))
    .filter((name) => name.startsWith("pre-migration-") && name.endsWith(".db"));

  expect(backups).toHaveLength(1);

  const backup = new Database(path.join(dataDir, "backups", backups[0]), {
    readonly: true,
  });
  expect(backup.prepare("SELECT COUNT(*) AS count FROM productos").get().count).toBe(2);
  expect(backup.pragma("table_info(productos)").some((column) => column.name === "stock")).toBe(
    false
  );
  backup.close();
});

test("una segunda ejecucion es idempotente y no crea otro respaldo", () => {
  const child = spawnSync(
    process.execPath,
    ["-e", "const { db } = require('./db'); db.close();"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATA_DIR: dataDir,
        JWT_SECRET: "migration-test-secret-with-at-least-32-characters",
        ADMIN_EMAIL: "admin@demo.com",
        ADMIN_PASSWORD: "Migration123!",
      },
    }
  );

  expect(child.status).toBe(0);
  const backups = fs
    .readdirSync(path.join(dataDir, "backups"))
    .filter((name) => name.startsWith("pre-migration-") && name.endsWith(".db"));
  expect(backups).toHaveLength(1);
});

test("un administrador eliminado no se resucita al reiniciar", () => {
  const writable = new Database(dbPath);
  writable.prepare("DELETE FROM users WHERE email = ?").run("admin@demo.com");
  writable.close();

  const child = spawnSync(
    process.execPath,
    ["-e", "const { db } = require('./db'); db.close();"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATA_DIR: dataDir,
        JWT_SECRET: "migration-test-secret-with-at-least-32-characters",
        ADMIN_EMAIL: "admin@demo.com",
        ADMIN_PASSWORD: "Migration123!",
      },
    }
  );

  expect(child.status).not.toBe(0);
  expect(`${child.stdout}\n${child.stderr}`).toContain(
    "No existe un usuario administrador"
  );
});

test("migracion de productos sin categoria_id agrega stock y categoria nula", () => {
  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-migration-no-category-"));
  const isolatedDb = path.join(isolatedDir, "app.db");
  const legacy = new Database(isolatedDb);
  legacy.exec(`
    CREATE TABLE productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      precio REAL NOT NULL CHECK (precio >= 0)
    );
    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,
      cantidad INTEGER NOT NULL CHECK (cantidad > 0),
      fecha TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'user' CHECK (rol IN ('admin', 'user'))
    );
  `);
  legacy
    .prepare("INSERT INTO users (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)")
    .run("Administrador", "admin@demo.com", "legacy-hash", "admin");
  legacy
    .prepare("INSERT INTO productos (nombre, precio) VALUES (?, ?)")
    .run("Producto sin categoria", 42);
  legacy.close();

  const child = spawnSync(
    process.execPath,
    ["-e", "const { db } = require('./db'); db.close();"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATA_DIR: isolatedDir,
        JWT_SECRET: "migration-test-secret-with-at-least-32-characters",
        ADMIN_EMAIL: "admin@demo.com",
        ADMIN_PASSWORD: "Migration123!",
      },
    }
  );

  expect(child.status).toBe(0);
  const migrated = new Database(isolatedDb, { readonly: true });
  expect(
    migrated.prepare("SELECT nombre, stock, categoria_id FROM productos").get()
  ).toEqual({ nombre: "Producto sin categoria", stock: 0, categoria_id: null });
  expect(migrated.pragma("foreign_key_check")).toEqual([]);
  migrated.close();

  fs.rmSync(isolatedDir, { recursive: true, force: true });
});

test("migracion normaliza correo y rol legacy sin perder al administrador", () => {
  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-migration-case-"));
  const isolatedDb = path.join(isolatedDir, "app.db");
  const legacy = new Database(isolatedDb);
  legacy.exec(`
    CREATE TABLE productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      precio REAL NOT NULL CHECK (precio >= 0),
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      categoria_id INTEGER REFERENCES categorias(id) ON DELETE RESTRICT
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'user'
    );
  `);
  legacy
    .prepare("INSERT INTO users (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)")
    .run("Administrador", "Admin@Demo.com", "legacy-hash", "Admin");
  legacy.close();

  const child = spawnSync(
    process.execPath,
    ["-e", "const { db } = require('./db'); db.close();"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATA_DIR: isolatedDir,
        JWT_SECRET: "migration-test-secret-with-at-least-32-characters",
        ADMIN_EMAIL: "admin@demo.com",
        ADMIN_PASSWORD: "Migration123!",
      },
    }
  );

  expect(child.status).toBe(0);
  const migrated = new Database(isolatedDb, { readonly: true });
  expect(
    migrated.prepare("SELECT email, rol, token_version FROM users").get()
  ).toEqual({ email: "admin@demo.com", rol: "admin", token_version: 0 });
  migrated.close();

  fs.rmSync(isolatedDir, { recursive: true, force: true });
});
