import { loadConfig } from "./core/config.js";
import { createLogger, setLogLevel } from "./core/logger.js";
import type { AppConfig } from "./core/types.js";

const log = createLogger("main");

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`FATAL: Config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  setLogLevel(config.logLevel);
  log.info("Gecko starting", {
    liveTrading: config.liveTrading,
    killSwitch: config.killSwitch,
    orbEnabled: config.orbEnabled,
    dte0Enabled: config.dte0Enabled,
    llmEnabled: config.llmEnabled,
  });

  // TODO(broker): wire Schwab auth/REST/stream once research returns
  // TODO(scanners): wire premarket gap scanner (9:00 ET daily) and 0DTE chain monitor
  // TODO(strategies): wire ORB and 0DTE engines
  // TODO(intelligence): wire LLM premarket classifier and self-tuner
  // TODO(execution): wire equity and option order routers
  // TODO(risk): wire daily stop, PDT counter, position sizer

  log.info("Skeleton running. No strategies wired yet.");

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutdown signal received: ${signal}`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled promise rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });

  // Keep the process alive until a real entry point exists.
  setInterval(() => { /* heartbeat placeholder */ }, 60_000);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
