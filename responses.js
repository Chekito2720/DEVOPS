"use strict";

/**
 * Construye los metadatos obligatorios de todas las respuestas JSON de la API.
 * responseTime se expresa en milisegundos con dos decimales.
 */
function responseMetadata(req, statusCode) {
  const startedAt = req.startedAtNs;
  const responseTime = startedAt
    ? Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2))
    : 0;

  const originalUrl = req.originalUrl || req.url || "/";
  const path = originalUrl.split("?")[0];

  return {
    statusCode,
    responseTime,
    request: req.method,
    path,
    timestamp: new Date().toISOString(),
  };
}

function ok(req, res, data, statusCode = 200) {
  return res.status(statusCode).json({
    ...responseMetadata(req, statusCode),
    data,
  });
}

function fail(req, res, statusCode, error) {
  return res.status(statusCode).json({
    ...responseMetadata(req, statusCode),
    error,
  });
}

module.exports = { responseMetadata, ok, fail };
