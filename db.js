"use strict";

const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const os = require("os");
const path = require("path");

const IS_TEST = process.env.NODE_ENV === "test";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = IS_TEST ? ":memory:" : path.join(DATA_DIR, "app.db");
const BACKUP_DIR = IS_TEST
  ? path.join(os.tmpdir(), "webapp-test-backups")
  : path.join(DATA_DIR, "backups");
const SEED_PATH = path.join(__dirname, "seed.sql");
const SCHEMA_VERSION = 3;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@demo.com").toLowerCase();

function resolveAdminPassword() {
  const configured = process.env.ADMIN_PASSWORD;
  if (configured) {
    if (configured.length < 8) {
      throw new Error("ADMIN_PASSWORD debe tener al menos 8 caracteres");
    }
    return configured;
  }

  if (["production", "staging"].includes(process.env.NODE_ENV)) {
    throw new Error("ADMIN_PASSWORD es obligatorio en produccion y staging");
  }

  return "Admin123!";
}

const ADMIN_PASSWORD = resolveAdminPassword();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const currentSchemaVersion = Number(db.pragma("user_version", { simple: true }));
if (currentSchemaVersion > SCHEMA_VERSION) {
  throw new Error(
    `La base de datos usa el esquema ${currentSchemaVersion}, pero esta version admite ${SCHEMA_VERSION}`
  );
}

function tableExists(tableName) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );
}

function tableColumns(tableName) {
  return db.pragma(`table_info(${tableName})`);
}

let preMigrationBackupCreated = false;

function createPreMigrationBackup() {
  if (IS_TEST || preMigrationBackupCreated) return;

  const backupFile = path.join(BACKUP_DIR, `pre-migration-${Date.now()}.db`);
  const escapedPath = backupFile.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedPath}'`);
  preMigrationBackupCreated = true;
  console.log(`[db] Respaldo previo a migracion: ${backupFile}`);
}

/**
 * Migra la tabla de productos de la practica anterior sin perder datos.
 * - agrega stock con valor 0;
 * - permite que categoria_id sea NULL;
 * - conserva la relacion con pedidos.
 */
function migrateProductsTable() {
  if (!tableExists("productos")) return;

  const columns = tableColumns("productos");
  const hasStock = columns.some((column) => column.name === "stock");
  const hasCategory = columns.some((column) => column.name === "categoria_id");
  const categoryColumn = columns.find((column) => column.name === "categoria_id");
  const categoryIsRequired = categoryColumn && categoryColumn.notnull === 1;

  if (hasStock && hasCategory && !categoryIsRequired) return;

  const stockExpression = hasStock ? "stock" : "0";
  const categoryExpression = hasCategory ? "categoria_id" : "NULL";
  const maxProductId = Number(
    db.prepare("SELECT MAX(id) AS max_id FROM productos").get().max_id || 0
  );
  let legacySequence = 0;
  if (tableExists("sqlite_sequence")) {
    const sequenceRow = db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'productos'")
      .get();
    legacySequence = Number(sequenceRow && sequenceRow.seq) || 0;
  }
  const preservedProductSequence = Math.max(legacySequence, maxProductId);

  createPreMigrationBackup();

  const sourceForeignKeyIssues = db.pragma("foreign_key_check");
  if (sourceForeignKeyIssues.length > 0) {
    throw new Error(
      `La tabla legacy productos contiene ${sourceForeignKeyIssues.length} referencias invalidas`
    );
  }

  db.pragma("foreign_keys = OFF");
  // Evita que SQLite reescriba la referencia de pedidos durante el RENAME.
  db.pragma("legacy_alter_table = ON");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      CREATE TABLE productos__migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        precio REAL NOT NULL CHECK (precio >= 0),
        stock INTEGER NOT NULL DEFAULT 0 CHECK (typeof(stock) = 'integer' AND stock >= 0),
        categoria_id INTEGER REFERENCES categorias(id) ON DELETE RESTRICT
          CHECK (categoria_id IS NULL OR typeof(categoria_id) = 'integer')
      );
    `);
    db.exec(`
      INSERT INTO productos__migrated (id, nombre, precio, stock, categoria_id)
      SELECT id, nombre, precio, ${stockExpression}, ${categoryExpression} FROM productos;
    `);
    db.exec("DROP TABLE productos;");
    db.exec("ALTER TABLE productos__migrated RENAME TO productos;");

    const sequenceUpdate = db
      .prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'productos'")
      .run(preservedProductSequence);
    if (sequenceUpdate.changes === 0) {
      db.prepare(
        "INSERT INTO sqlite_sequence (name, seq) VALUES ('productos', ?)"
      ).run(preservedProductSequence);
    }

    const migratedForeignKeyIssues = db.pragma("foreign_key_check");
    if (migratedForeignKeyIssues.length > 0) {
      throw new Error(
        `La migracion de productos produjo ${migratedForeignKeyIssues.length} referencias invalidas`
      );
    }

    db.exec("COMMIT;");
    console.log("[db] Tabla productos migrada: stock agregado y categoria_id opcional");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }
}

function migrateUsersTable() {
  if (!tableExists("users")) return;

  const columns = tableColumns("users");
  const needsTokenVersion = !columns.some(
    (column) => column.name === "token_version"
  );
  const users = db
    .prepare("SELECT id, email, rol FROM users ORDER BY id")
    .all();
  const normalizedEmails = new Map();

  for (const user of users) {
    const normalizedEmail = String(user.email || "").trim().toLowerCase();
    const normalizedRole = String(user.rol || "").trim().toLowerCase();

    if (!normalizedEmail || !["admin", "user"].includes(normalizedRole)) {
      throw new Error(
        `El usuario legacy ${user.id} tiene un email o rol no normalizable`
      );
    }
    if (normalizedEmails.has(normalizedEmail)) {
      throw new Error(
        `Los usuarios legacy ${normalizedEmails.get(normalizedEmail)} y ${user.id} comparten el email ${normalizedEmail}`
      );
    }
    normalizedEmails.set(normalizedEmail, user.id);
  }

  const needsNormalization = users.some(
    (user) =>
      user.email !== String(user.email).trim().toLowerCase() ||
      user.rol !== String(user.rol).trim().toLowerCase()
  );

  if (!needsTokenVersion && !needsNormalization) {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users(email COLLATE NOCASE)"
    );
    return;
  }

  createPreMigrationBackup();
  const migrateUsers = db.transaction(() => {
    if (needsTokenVersion) {
      db.exec(
        "ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0)"
      );
    }

    const update = db.prepare("UPDATE users SET email = ?, rol = ? WHERE id = ?");
    for (const user of users) {
      update.run(
        String(user.email).trim().toLowerCase(),
        String(user.rol).trim().toLowerCase(),
        user.id
      );
    }

    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users(email COLLATE NOCASE)"
    );
  });

  migrateUsers();
  console.log(
    "[db] Tabla users migrada: token_version y valores normalizados"
  );
}

const usersTableExisted = tableExists("users");

db.exec(`
  CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE
  );
`);

migrateProductsTable();

db.exec(`
  CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    precio REAL NOT NULL CHECK (precio >= 0),
    stock INTEGER NOT NULL DEFAULT 0 CHECK (typeof(stock) = 'integer' AND stock >= 0),
    categoria_id INTEGER REFERENCES categorias(id) ON DELETE RESTRICT
      CHECK (categoria_id IS NULL OR typeof(categoria_id) = 'integer')
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL DEFAULT 'user' CHECK (rol IN ('admin', 'user')),
    token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0)
  );

  CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE RESTRICT
      CHECK (typeof(producto_id) = 'integer'),
    cantidad INTEGER NOT NULL CHECK (typeof(cantidad) = 'integer' AND cantidad > 0),
    fecha TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(categoria_id);
  CREATE INDEX IF NOT EXISTS idx_pedidos_producto ON pedidos(producto_id);
`);

migrateUsersTable();

if (currentSchemaVersion < SCHEMA_VERSION) {
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function ensureAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL);
  if (existing) return;

  db.prepare(
    "INSERT INTO users (nombre, email, password_hash, rol) VALUES (?, ?, ?, 'admin')"
  ).run("Administrador", ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 10));
}

function seedDb() {
  if (!fs.existsSync(SEED_PATH)) return;
  db.exec(fs.readFileSync(SEED_PATH, "utf8"));
}

function resetDb() {
  const reset = db.transaction(() => {
    db.exec(`
      DELETE FROM pedidos;
      DELETE FROM productos;
      DELETE FROM categorias;
      DELETE FROM users;
      DELETE FROM sqlite_sequence WHERE name IN ('pedidos', 'productos', 'categorias', 'users');
    `);
    seedDb();
    ensureAdmin();
  });

  reset();
}

const categoryCount = db.prepare("SELECT COUNT(*) AS count FROM categorias").get().count;
if (categoryCount === 0) {
  seedDb();
  if (!IS_TEST) console.log("[db] Seed cargado en la base de datos");
}
if (!usersTableExisted) {
  ensureAdmin();
}

const adminCount = db
  .prepare("SELECT COUNT(*) AS count FROM users WHERE rol = 'admin'")
  .get().count;
if (!IS_TEST && adminCount === 0) {
  throw new Error(
    "No existe un usuario administrador. Recupera o crea el rol admin antes de iniciar la aplicacion"
  );
}

module.exports = { db, BACKUP_DIR, DATA_DIR, resetDb, seedDb };
