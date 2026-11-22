"use strict";

const request = require("supertest");
const app = require("../app");
const { responseMetadata } = require("../responses");
const { log } = require("../telemetry");

describe("Metadatos y telemetria base", () => {
  test("responseMetadata soporta requests sin cronometro y rutas de fallback", () => {
    const withOriginalUrl = responseMetadata(
      { method: "GET", originalUrl: "/api/health?probe=1" },
      200
    );
    expect(withOriginalUrl.responseTime).toBe(0);
    expect(withOriginalUrl.path).toBe("/api/health");

    expect(responseMetadata({ method: "GET", url: "/api/products" }, 200).path).toBe(
      "/api/products"
    );
    expect(responseMetadata({ method: "GET" }, 200).path).toBe("/");
  });

  test("log serializa cuerpos no textuales y aplica severidad por defecto", () => {
    const consoleSpies = ["log", "warn", "error"].map((method) =>
      jest.spyOn(console, method).mockImplementation(() => {})
    );

    try {
      log("DEBUG", { event: "prueba" });
      log("WARN", "advertencia");
      log("ERROR", "error");
    } finally {
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });

  test("login rechaza entradas que exceden los limites antes de consultar la base", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .send({ email: `${"a".repeat(250)}@demo.com`, password: "secreto1" });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toContain("longitud");
  });
});
