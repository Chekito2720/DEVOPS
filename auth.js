"use strict";

const jwt = require("jsonwebtoken");
const { db } = require("./db");
const { fail } = require("./responses");
const { dbSpan, log } = require("./telemetry");

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "2h";

function resolveJwtSecret() {
  const configured = process.env.JWT_SECRET;
  if (configured) {
    if (configured.length < 32) {
      throw new Error("JWT_SECRET debe tener al menos 32 caracteres");
    }
    return configured;
  }

  if (["production", "staging"].includes(process.env.NODE_ENV)) {
    throw new Error("JWT_SECRET es obligatorio en produccion y staging");
  }

  return "dev-secret-change-me-with-at-least-32-characters";
}

const JWT_SECRET = resolveJwtSecret();

function sign(user) {
  return jwt.sign(
    {
      id: Number(user.id),
      rol: user.rol,
      email: user.email,
      ver: Number(user.token_version || 0),
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, algorithm: "HS256" }
  );
}

function requireAuth(req, res, next) {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;

  if (!token) {
    return fail(req, res, 401, "Token requerido");
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  } catch (_error) {
    return fail(req, res, 401, "Token invalido o expirado");
  }

  let currentUser;
  try {
    const userId = Number(payload.id);
    currentUser = dbSpan("users.authenticate", () =>
      db
        .prepare(
          "SELECT id, nombre, email, rol, token_version FROM users WHERE id = ?"
        )
        .get(userId)
    );
  } catch (error) {
    log("ERROR", error.message, { route: req.originalUrl || req.url });
    return fail(req, res, 500, "Error interno");
  }

  if (
    !currentUser ||
    Number(currentUser.token_version || 0) !== Number(payload.ver || 0)
  ) {
    return fail(req, res, 401, "Token invalido o expirado");
  }

  req.user = {
    id: Number(currentUser.id),
    nombre: currentUser.nombre,
    email: currentUser.email,
    rol: currentUser.rol,
  };
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.rol !== "admin") {
    return fail(req, res, 403, "Se requieren permisos de administrador");
  }
  return next();
}

module.exports = { sign, requireAuth, requireAdmin };
