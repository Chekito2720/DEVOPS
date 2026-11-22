"use strict";

const net = require("net");
const app = require("./app");
const { db } = require("./db");
const { log, dbSpan } = require("./telemetry");

const PORT = Number(process.env.PORT || 80);
const TCP_PORT = Number(process.env.TCP_PORT || 6061);
const MAX_TCP_BUFFER_BYTES = 64 * 1024;
const TCP_IDLE_TIMEOUT_MS = 30 * 1000;

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`API escuchando en el puerto ${PORT}`);
});

function sendTcp(socket, payload) {
  if (socket.destroyed || !socket.writable) return;

  const serialized = `${JSON.stringify(payload)}\n`;
  socket.write(serialized, (error) => {
    if (!error) return;
    log("WARN", "No se pudo enviar la respuesta TCP", {
      protocol: "tcp",
      error: error.message,
    });
  });
}

function isValidTcpInsert(element) {
  if (!element || typeof element !== "object" || Array.isArray(element)) {
    return false;
  }
  if (typeof element.nombre !== "string" || !element.nombre.trim()) {
    return false;
  }
  if (
    typeof element.precio !== "number" ||
    !Number.isFinite(element.precio) ||
    element.precio < 0
  ) {
    return false;
  }
  if (
    element.stock !== undefined &&
    (!Number.isSafeInteger(element.stock) || element.stock < 0)
  ) {
    return false;
  }
  if (
    element.categoria_id !== undefined &&
    element.categoria_id !== null &&
    (!Number.isSafeInteger(element.categoria_id) || element.categoria_id <= 0)
  ) {
    return false;
  }
  return true;
}

function processTcpMessage(socket, rawMessage) {
  const message = rawMessage.trim();
  if (!message) return;

  // {insert:<element>} -> insertar producto
  const insertMatch = message.match(/^\{insert:(.+)\}$/s);
  if (insertMatch) {
    let element;
    try {
      element = JSON.parse(insertMatch[1]);
    } catch (_error) {
      sendTcp(socket, { statusCode: 400, error: "Formato invalido" });
      return;
    }

    if (!isValidTcpInsert(element)) {
      sendTcp(socket, { statusCode: 400, error: "Formato invalido" });
      return;
    }

    try {
      const info = dbSpan("productos.insert", () => {
        const statement = db.prepare(
          "INSERT INTO productos (nombre, precio, stock, categoria_id) VALUES (?, ?, ?, ?)"
        );
        return statement.run(
          element.nombre.trim(),
          element.precio,
          element.stock ?? 0,
          element.categoria_id ?? null
        );
      });

      const insertedId = Number(info.lastInsertRowid);
      log("INFO", "tcp insert completado", {
        protocol: "tcp",
        product_id: insertedId,
      });
      sendTcp(socket, {
        statusCode: 200,
        data: { id: insertedId },
      });
    } catch (error) {
      if (String(error.message).includes("FOREIGN KEY")) {
        sendTcp(socket, { statusCode: 400, error: "Formato invalido" });
        return;
      }
      log("ERROR", error.message, { protocol: "tcp" });
      sendTcp(socket, { statusCode: 500, error: "Error interno" });
    }
    return;
  }

  // {get:<element>} -> obtener producto por id, ej. {"id":1}
  const getMatch = message.match(/^\{get:(.+)\}$/s);
  if (getMatch) {
    let id;
    try {
      id = JSON.parse(getMatch[1]).id;
    } catch (_error) {
      sendTcp(socket, { statusCode: 400, error: "Formato invalido" });
      return;
    }

    if (!Number.isSafeInteger(id) || id <= 0) {
      sendTcp(socket, { statusCode: 400, error: "Formato invalido" });
      return;
    }

    try {
      const row = dbSpan("productos.get", () =>
        db
          .prepare(
            `SELECT p.id, p.nombre, p.precio, p.stock, p.categoria_id, c.nombre AS categoria
             FROM productos p
             LEFT JOIN categorias c ON c.id = p.categoria_id
             WHERE p.id = ?`
          )
          .get(id)
      );
      log("INFO", "tcp get completado", {
        protocol: "tcp",
        product_id: id,
        found: Boolean(row),
      });
      sendTcp(socket, {
        statusCode: row ? 200 : 404,
        data: row || null,
      });
    } catch (error) {
      log("ERROR", error.message, { protocol: "tcp" });
      sendTcp(socket, { statusCode: 500, error: "Error interno" });
    }
    return;
  }

  sendTcp(socket, { statusCode: 400, error: "Comando no reconocido" });
}

/**
 * Extrae un comando legacy completo sin depender de los limites de TCP.
 * El valor JSON puede contener objetos o arrays anidados.
 */
function extractTcpCommand(buffer) {
  const prefix = buffer.startsWith("{insert:")
    ? "{insert:"
    : buffer.startsWith("{get:")
      ? "{get:"
      : null;
  if (!prefix) return null;

  const valueStart = prefix.length;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = valueStart; index < buffer.length; index += 1) {
    const character = buffer[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      if (depth === 0) {
        // Permite un valor JSON primitivo, por ejemplo {get:1}.
        try {
          JSON.parse(buffer.slice(valueStart, index));
        } catch (_error) {
          return null;
        }
        return buffer[index] === "}"
          ? {
              command: buffer.slice(0, index + 1),
              rest: buffer.slice(index + 1),
            }
          : null;
      }

      depth -= 1;
      if (depth === 0) {
        const valueEnd = index + 1;
        if (buffer[valueEnd] !== "}") return null;
        return {
          command: buffer.slice(0, valueEnd + 1),
          rest: buffer.slice(valueEnd + 1),
        };
      }
    }
  }

  return null;
}

function processTcpBuffer(socket, buffer) {
  let remaining = buffer;

  while (remaining.length > 0) {
    remaining = remaining.trimStart();
    if (!remaining) break;

    const extracted = extractTcpCommand(remaining);
    if (extracted) {
      processTcpMessage(socket, extracted.command);
      remaining = extracted.rest;
      continue;
    }

    const newlineIndex = remaining.indexOf("\n");
    if (newlineIndex >= 0) {
      const message = remaining.slice(0, newlineIndex);
      remaining = remaining.slice(newlineIndex + 1);
      processTcpMessage(socket, message);
      continue;
    }

    const candidate = remaining.trim();
    const startsWithKnownCommand =
      candidate.startsWith("{insert:") || candidate.startsWith("{get:");
    if (!startsWithKnownCommand && /^\{[\s\S]*\}$/.test(candidate)) {
      processTcpMessage(socket, candidate);
      remaining = "";
    }
    break;
  }

  return remaining;
}

// ---------- Servidor TCP crudo (puerto 6061, formato previo conservado) ----------
const tcpServer = net.createServer((socket) => {
  let buffer = "";
  let rejected = false;
  socket.setEncoding("utf8");
  socket.setTimeout(TCP_IDLE_TIMEOUT_MS);

  socket.on("data", (data) => {
    if (rejected) return;

    buffer += data;
    if (Buffer.byteLength(buffer, "utf8") > MAX_TCP_BUFFER_BYTES) {
      rejected = true;
      buffer = "";
      sendTcp(socket, { statusCode: 400, error: "Comando demasiado grande" });
      socket.end();
      return;
    }

    buffer = processTcpBuffer(socket, buffer);
  });

  socket.on("timeout", () => {
    if (rejected) return;
    rejected = true;
    buffer = "";
    sendTcp(socket, { statusCode: 400, error: "Tiempo de espera excedido" });
    socket.end();
  });

  socket.on("end", () => {
    if (!rejected && buffer.trim()) processTcpMessage(socket, buffer);
    buffer = "";
  });

  socket.on("error", (error) => {
    log("WARN", "Conexion TCP cerrada con error", {
      protocol: "tcp",
      error: error.message,
    });
    socket.destroy();
  });
});

tcpServer.on("error", (error) => {
  log("ERROR", error.message, { protocol: "tcp" });
  httpServer.close(() => process.exit(1));
});

tcpServer.listen(TCP_PORT, "0.0.0.0", () => {
  console.log(`Servidor TCP escuchando en el puerto ${TCP_PORT}`);
});

module.exports = { httpServer, tcpServer };
