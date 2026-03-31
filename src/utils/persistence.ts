import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";

const log = createLogger("persistence");

export function appendJsonl(filePath: string, data: unknown): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(data) + "\n";
    fs.appendFileSync(filePath, line, "utf-8");
  } catch (err) {
    log.error("Failed to append to JSONL file", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function readJsonl<T>(filePath: string): T[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const results: T[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        results.push(JSON.parse(lines[i]) as T);
      } catch (lineErr) {
        log.warn("Skipping corrupt JSONL line", {
          filePath,
          lineNumber: i + 1,
          error: lineErr instanceof Error ? lineErr.message : String(lineErr),
        });
      }
    }
    return results;
  } catch (err) {
    log.error("Failed to read JSONL file", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
