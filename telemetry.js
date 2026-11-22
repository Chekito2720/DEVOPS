"use strict";

const {
  logs,
  metrics,
  SeverityNumber,
  SpanStatusCode,
  trace,
} = require("@opentelemetry/api");

const meter = metrics.getMeter("api-cicd");
const tracer = trace.getTracer("api-cicd");
const logger = logs.getLogger("api-cicd");

const requestCounter = meter.createCounter("http_requests_total", {
  description: "Cantidad total de solicitudes HTTP recibidas",
});

const requestDuration = meter.createHistogram("http_request_duration_ms", {
  description: "Latencia de respuestas HTTP en milisegundos",
  unit: "ms",
});

function normalizeRoute(req) {
  if (req.route && req.route.path) {
    return `${req.baseUrl || ""}${req.route.path}`;
  }
  return "unmatched";
}

function log(level, body, attributes = {}) {
  const severity = SeverityNumber[level] ?? SeverityNumber.INFO;
  const record = {
    severityNumber: severity,
    severityText: level,
    body: typeof body === "string" ? body : JSON.stringify(body),
    attributes,
  };

  logger.emit(record);

  // La salida en consola facilita el diagnostico local; en EC2 el Collector
  // recibe la misma Structured Log Record mediante OTLP/HTTP.
  const consoleMethod = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
  console[consoleMethod](
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message: record.body,
      ...attributes,
    })
  );
}

function metricsMiddleware(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const attributes = {
      route: normalizeRoute(req),
      method: req.method,
      status_code: res.statusCode,
      ...(req.user && req.user.id ? { user_id: req.user.id } : {}),
    };

    requestCounter.add(1, attributes);
    requestDuration.record(durationMs, attributes);

    const level = res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO";
    log(level, "request", {
      ...attributes,
      response_time_ms: Number(durationMs.toFixed(2)),
    });
  });

  next();
}

/** Crea un span sincrono para una consulta a SQLite. */
function dbSpan(name, operation) {
  return tracer.startActiveSpan(`db.${name}`, (span) => {
    try {
      return operation();
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Crea un span asincrono para una operacion de base de datos. */
async function dbSpanAsync(name, operation) {
  return tracer.startActiveSpan(`db.${name}`, async (span) => {
    try {
      return await operation();
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

module.exports = { metricsMiddleware, log, dbSpan, dbSpanAsync };
