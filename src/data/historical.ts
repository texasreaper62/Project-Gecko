import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import type { SchwabRest } from "../brokers/schwab/rest.js";
import type { Bar } from "../core/types.js";

const log = createLogger("historical");
const CACHE_ROOT = "data/bars";

export type BarFrequencyType = "minute" | "daily" | "weekly" | "monthly";

export interface HistoricalFetchParams {
  readonly symbol: string;
  readonly frequencyType: BarFrequencyType;
  readonly frequency: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly extendedHours?: boolean;
}

// Wraps SchwabRest.getPriceHistory with a per-symbol JSONL cache under data/bars/.
// Merges fresh fetches into the cache and serves cached bars when the requested
// range is already covered.
export class HistoricalBars {
  constructor(private readonly rest: SchwabRest) {}

  async fetch(params: HistoricalFetchParams): Promise<readonly Bar[]> {
    const cachePath = cacheKey(params);
    const cached = readCache(cachePath);
    const inRange = filterRange(cached, params.startMs, params.endMs);

    if (coversRange(cached, params)) {
      return inRange;
    }

    try {
      const resp = await this.rest.getPriceHistory({
        symbol: params.symbol,
        frequencyType: params.frequencyType,
        frequency: params.frequency,
        startDate: params.startMs,
        endDate: params.endMs,
        needExtendedHoursData: params.extendedHours ?? false,
      });
      const fresh: Bar[] = resp.candles.map((c) => ({
        symbol: params.symbol,
        timestamp: c.datetime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      const merged = mergeBars(cached, fresh);
      writeCache(cachePath, merged);
      return filterRange(merged, params.startMs, params.endMs);
    } catch (err) {
      log.error("Failed to fetch price history", {
        symbol: params.symbol,
        frequencyType: params.frequencyType,
        frequency: params.frequency,
        error: err instanceof Error ? err.message : String(err),
      });
      return inRange;
    }
  }

  // Synchronous best-effort read from the on-disk cache. Returns whatever
  // bars are already cached for the (symbol, frequencyType, frequency) tuple
  // within the requested window. Used by the multi-timeframe validator,
  // which must run synchronously inside the order-routing decision path.
  peekCache(symbol: string, frequencyType: BarFrequencyType, frequency: number, startMs: number, endMs: number): readonly Bar[] {
    const filePath = cacheKey({ symbol, frequencyType, frequency });
    const cached = readCache(filePath);
    return filterRange(cached, startMs, endMs);
  }
}

function cacheKey(p: { symbol: string; frequencyType: BarFrequencyType; frequency: number }): string {
  const safe = p.symbol.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(CACHE_ROOT, `${safe}_${p.frequencyType}_${p.frequency}.jsonl`);
}

function readCache(filePath: string): readonly Bar[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter((l) => l.trim().length > 0);
    const bars: Bar[] = [];
    for (const line of lines) {
      try {
        bars.push(JSON.parse(line) as Bar);
      } catch {
        // Skip corrupt lines silently — cache is best-effort.
      }
    }
    bars.sort((a, b) => a.timestamp - b.timestamp);
    return bars;
  } catch {
    return [];
  }
}

function writeCache(filePath: string, bars: readonly Bar[]): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = bars.map((b) => JSON.stringify(b)).join("\n") + (bars.length > 0 ? "\n" : "");
    fs.writeFileSync(filePath, lines, "utf-8");
  } catch (err) {
    log.warn("Failed to write bar cache", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function mergeBars(cached: readonly Bar[], fresh: readonly Bar[]): readonly Bar[] {
  const byTs = new Map<number, Bar>();
  for (const b of cached) byTs.set(b.timestamp, b);
  for (const b of fresh) byTs.set(b.timestamp, b);
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function filterRange(bars: readonly Bar[], startMs: number, endMs: number): readonly Bar[] {
  return bars.filter((b) => b.timestamp >= startMs && b.timestamp <= endMs);
}

// Returns true when the cache appears to cover the requested window with
// enough slack that we can skip a network fetch. Heuristic: at least one
// bar at or before startMs and at or after endMs, modulo a slack window
// sized to the bar frequency.
function coversRange(bars: readonly Bar[], p: HistoricalFetchParams): boolean {
  if (bars.length === 0) return false;
  const slack = p.frequencyType === "daily"
    ? 24 * 60 * 60 * 1000
    : 60 * 60 * 1000;
  const first = bars[0].timestamp;
  const last = bars[bars.length - 1].timestamp;
  return first <= p.startMs + slack && last >= p.endMs - slack;
}
