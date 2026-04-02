import type { LogLevel, LogEntry } from "./types.js";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function createLogger(component: string): Logger {
  return new Logger(component);
}

export class Logger {
  private readonly component: string;

  constructor(component: string) {
    this.component = component;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLevel]) {
      return;
    }

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...(data !== undefined ? { data } : {}),
    };

    const line = JSON.stringify(entry);

    if (level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }
}
