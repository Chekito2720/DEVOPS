"use strict";

// Las pruebas usan puertos efímeros y una base SQLite en memoria.
process.env.NODE_ENV = "test";
process.env.PORT = "0";
process.env.TCP_PORT = "0";

const net = require("net");
const { once } = require("events");
const { db, resetDb } = require("../db");
const { httpServer, tcpServer } = require("../server");

function waitForListening(server) {
  return server.listening ? Promise.resolve() : once(server, "listening");
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function sendTcpChunks(chunks, expectedResponses = 1) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: tcpServer.address().port,
    });
    const responses = [];
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timeout esperando respuestas TCP"));
    }, 3000);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      chunks.forEach((chunk, index) => {
        setTimeout(() => socket.write(chunk), index * 15);
      });
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        responses.push(JSON.parse(line));
      }
      if (responses.length >= expectedResponses) {
        clearTimeout(timeout);
        socket.end();
        resolve(responses);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("close", () => {
      if (responses.length < expectedResponses) {
        clearTimeout(timeout);
        reject(new Error("La conexion TCP se cerro antes de la respuesta"));
      }
    });
  });
}

function sendTcp(message) {
  return sendTcpChunks([`${message}\n`]).then((responses) => responses[0]);
}

beforeAll(async () => {
  await Promise.all([waitForListening(httpServer), waitForListening(tcpServer)]);
  resetDb();
});

afterAll(async () => {
  await Promise.all([closeServer(httpServer), closeServer(tcpServer)]);
});

describe("Protocolo TCP legacy 6061", () => {
  test("get conserva el envelope anterior y devuelve un producto", async () => {
    const response = await sendTcp('{get:{"id":1}}');

    expect(response).toEqual({
      statusCode: 200,
      data: expect.objectContaining({ id: 1, nombre: "Laptop" }),
    });
    expect(response).not.toHaveProperty("responseTime");
    expect(response).not.toHaveProperty("timestamp");
  });

  test("reensambla un comando fragmentado por TCP", async () => {
    const responses = await sendTcpChunks(["{get:", '{"id":1}}']);

    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({
      statusCode: 200,
      data: expect.objectContaining({ id: 1, nombre: "Laptop" }),
    });
  });

  test("procesa dos comandos coalescentes en una sola lectura", async () => {
    const responses = await sendTcpChunks(
      ['{get:{"id":1}}{get:{"id":2}}'],
      2
    );

    expect(responses).toHaveLength(2);
    expect(responses.map((response) => response.data.id)).toEqual([1, 2]);
  });

  test("acepta comandos separados por espacios y terminador CRLF", async () => {
    const responses = await sendTcpChunks(
      [' {get:{"id":1}} {get:{"id":2}}\r\n'],
      2
    );

    expect(responses).toHaveLength(2);
    expect(responses.map((response) => response.data.id)).toEqual([1, 2]);
  });

  test("insert agrega stock y responde con el id generado", async () => {
    const response = await sendTcp(
      '{insert:{"nombre":"Producto TCP","precio":12.5,"stock":3}}'
    );

    expect(response.statusCode).toBe(200);
    expect(response.data.id).toEqual(expect.any(Number));

    const product = db
      .prepare("SELECT nombre, precio, stock FROM productos WHERE id = ?")
      .get(response.data.id);
    expect(product).toEqual({ nombre: "Producto TCP", precio: 12.5, stock: 3 });
  });

  test("un comando desconocido conserva el contrato de error legacy", async () => {
    const response = await sendTcp("{desconocido:true}");

    expect(response).toEqual({ statusCode: 400, error: "Comando no reconocido" });
  });

  test("rechaza enteros fuera del rango seguro", async () => {
    const response = await sendTcp(
      '{insert:{"nombre":"Stock inseguro","precio":1,"stock":1e100}}'
    );

    expect(response).toEqual({ statusCode: 400, error: "Formato invalido" });
  });

  test("rechaza un buffer TCP mayor al limite", async () => {
    const response = await sendTcpChunks([`${"x".repeat(70 * 1024)}\n`]);

    expect(response).toHaveLength(1);
    expect(response[0]).toEqual({
      statusCode: 400,
      error: "Comando demasiado grande",
    });
  });
});
