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
    const lines = content.trim().split("\n").filter((l) => l.length > 0);
    return lines.map((l) => JSON.parse(l) as T);
  } catch (err) {
    log.error("Failed to read JSONL file", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
