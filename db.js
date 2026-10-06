const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const os = require("os");

const IS_TEST = process.env.NODE_ENV === "test";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
// En tests usamos SQLite en memoria para no ensuciar la BD real
const DB_PATH = IS_TEST ? ":memory:" : path.join(DATA_DIR, "app.db");
const BACKUP_DIR = IS_TEST
  ? path.join(os.tmpdir(), "webapp-test-backups")
  : path.join(DATA_DIR, "backups");
const SEED_PATH = path.join(__dirname, "seed.sql");

if (!IS_TEST) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Crear tablas
db.exec(`
  CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    precio REAL NOT NULL CHECK (precio >= 0),
    categoria_id INTEGER NOT NULL REFERENCES categorias(id) ON DELETE RESTRICT
  );
  CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,
    cantidad INTEGER NOT NULL CHECK (cantidad > 0),
    fecha TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Cargar seed si la BD esta vacia
function seedDb() {
  if (fs.existsSync(SEED_PATH)) {
    db.exec(fs.readFileSync(SEED_PATH, "utf8"));
  }
}

// Vacia todas las tablas y recarga el seed (usado por los tests)
function resetDb() {
  db.exec(`
    DELETE FROM pedidos;
    DELETE FROM productos;
    DELETE FROM categorias;
    DELETE FROM sqlite_sequence WHERE name IN ('pedidos','productos','categorias');
  `);
  seedDb();
}

const count = db.prepare("SELECT COUNT(*) AS c FROM categorias").get().c;
if (count === 0) {
  seedDb();
  if (!IS_TEST) console.log("Seed cargado en la BD");
}

module.exports = { db, BACKUP_DIR, resetDb };
