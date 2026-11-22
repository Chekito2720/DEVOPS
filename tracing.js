"use strict";

const { NodeSDK } = require("@opentelemetry/sdk-node");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
const { BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");

const baseEndpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318").replace(
  /\/$/,
  ""
);

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME || "api-cicd",
  traceExporter: new OTLPTraceExporter({ url: `${baseEndpoint}/v1/traces` }),
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${baseEndpoint}/v1/metrics` }),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 15000),
    }),
  ],
  logRecordProcessors: [
    new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({ url: `${baseEndpoint}/v1/logs` }),
      scheduledDelayMillis: 1000,
    }),
  ],
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
});

sdk.start();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[telemetry] Cerrando SDK OpenTelemetry (${signal})`);
  try {
    await sdk.shutdown();
  } finally {
    process.exit(0);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

module.exports = { sdk };
