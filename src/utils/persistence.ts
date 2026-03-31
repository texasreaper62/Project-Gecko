import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../core/logger.js";

const log = createLogger("persistence");

export function appendJsonl(filePath: string, record: unknown): void {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(record) + "\n";
    appendFileSync(filePath, line, "utf-8");
  } catch (err) {
    log.error("Failed to append to JSONL", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
