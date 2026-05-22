import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { createLogger } from "../core/logger.js";
import type { Bar } from "../core/types.js";

const log = createLogger("yahoo-historical");
const CACHE_ROOT = "data/bars-yahoo";

export type YahooInterval = "1m" | "5m" | "15m" | "1h" | "1d";

export interface YahooFetchParams {
  readonly symbol: string;
  readonly interval: YahooInterval;
  readonly startMs: number;
  readonly endMs: number;
  readonly includePrePost?: boolean;
  // When false, skip the on-disk cache and always fetch fresh. Useful for
  // pre-market data where Yahoo's cached snapshot may lag behind the live
  // chart. Defaults to true.
  readonly cache?: boolean;
}

// Yahoo Finance public chart endpoint. No auth required. We use the range
// keyword (5d / 60d / 2y / etc.) rather than period1/period2 timestamp pairs
// because the range keyword path is more reliable across symbols. Result is
// filtered down to the requested startMs/endMs window after fetch.
//
// Throttled by a per-instance promise chain so concurrent callers serialize.
// Caches each (symbol, interval) tuple as JSONL under data/bars-yahoo/.
export class YahooHistoricalBars {
  private chain: Promise<void> = Promise.resolve();
  private lastFetchMs = 0;
  private readonly minIntervalMs = 250;

  async fetch(params: YahooFetchParams): Promise<readonly Bar[]> {
    const useCache = params.cache !== false;
    const cachePath = cacheKey(params.symbol, params.interval);
    const cached = useCache ? readCache(cachePath) : [];
    const inRange = filterRange(cached, params.startMs, params.endMs);

    if (useCache && coversRange(cached, params)) {
      return inRange;
    }

    try {
      const fresh = await this.throttledFetch(params);
      const merged = mergeBars(cached, fresh);
      if (useCache) writeCache(cachePath, merged);
      return filterRange(merged, params.startMs, params.endMs);
    } catch (err) {
      log.error("Yahoo fetch failed", {
        symbol: params.symbol,
        interval: params.interval,
        error: err instanceof Error ? err.message : String(err),
      });
      return inRange;
    }
  }

  private throttledFetch(params: YahooFetchParams): Promise<readonly Bar[]> {
    const next = this.chain.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastFetchMs);
      if (wait > 0) await sleep(wait);
      this.lastFetchMs = Date.now();
      return fetchFromYahoo(params);
    });
    // Detach error from chain so one failure doesn't poison subsequent fetches.
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }
}

async function fetchFromYahoo(params: YahooFetchParams): Promise<readonly Bar[]> {
  const range = pickRange(params);
  const qs = new URLSearchParams({
    interval: params.interval,
    range,
    includePrePost: String(params.includePrePost ?? false),
    events: "div,splits",
  });
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(params.symbol)}?${qs.toString()}`;
  const raw = await httpGet(url);
  const json = JSON.parse(raw) as YahooChartResponse;
  const result = json.chart?.result?.[0];
  if (!result || !result.timestamp || !result.indicators?.quote?.[0]) return [];
  const ts = result.timestamp;
  const q = result.indicators.quote[0];
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    const v = q.volume?.[i];
    if (
      typeof o !== "number" || typeof h !== "number" ||
      typeof l !== "number" || typeof c !== "number" ||
      !Number.isFinite(o) || !Number.isFinite(h) ||
      !Number.isFinite(l) || !Number.isFinite(c)
    ) continue;
    bars.push({
      symbol: params.symbol.toUpperCase(),
      timestamp: ts[i] * 1000,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: typeof v === "number" && Number.isFinite(v) ? v : 0,
    });
  }
  return bars;
}

// Map a requested time window to the smallest Yahoo range keyword that
// covers it, subject to Yahoo's per-interval maximums:
//   1m  -> max 7d
//   5m  -> max 60d
//   15m -> max 60d
//   1h  -> max 730d
//   1d  -> max 'max'
function pickRange(params: YahooFetchParams): string {
  const days = Math.ceil((params.endMs - params.startMs) / (24 * 60 * 60 * 1000));
  if (params.interval === "1m") {
    if (days <= 1) return "1d";
    if (days <= 5) return "5d";
    return "7d";
  }
  if (params.interval === "5m" || params.interval === "15m") {
    if (days <= 5) return "5d";
    if (days <= 30) return "1mo";
    return "60d";
  }
  if (params.interval === "1h") {
    if (days <= 30) return "1mo";
    if (days <= 90) return "3mo";
    if (days <= 180) return "6mo";
    if (days <= 365) return "1y";
    return "2y";
  }
  // 1d
  if (days <= 30) return "1mo";
  if (days <= 90) return "3mo";
  if (days <= 180) return "6mo";
  if (days <= 365) return "1y";
  if (days <= 2 * 365) return "2y";
  if (days <= 5 * 365) return "5y";
  if (days <= 10 * 365) return "10y";
  return "max";
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        // Yahoo blocks the default node-https UA.
        "User-Agent": "Mozilla/5.0 (compatible; gecko-bot/0.2)",
        "Accept": "application/json",
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`Yahoo HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("Yahoo request timeout")));
  });
}

function cacheKey(symbol: string, interval: YahooInterval): string {
  const safe = symbol.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(CACHE_ROOT, `${safe}_${interval}.jsonl`);
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
        // Best-effort, skip corrupt lines.
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
    log.warn("Failed to write yahoo bar cache", {
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

// Yahoo's intraday endpoints can't reach back arbitrarily far — if the
// cache covers the requested window with slack, skip the network fetch.
function coversRange(bars: readonly Bar[], p: YahooFetchParams): boolean {
  if (bars.length === 0) return false;
  const slack = p.interval === "1d" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const first = bars[0].timestamp;
  const last = bars[bars.length - 1].timestamp;
  return first <= p.startMs + slack && last >= p.endMs - slack;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -- Yahoo response shape (partial) --

interface YahooChartResponse {
  readonly chart?: {
    readonly result?: readonly YahooChartResult[];
    readonly error?: unknown;
  };
}

interface YahooChartResult {
  readonly timestamp?: readonly number[];
  readonly indicators?: {
    readonly quote?: readonly YahooQuoteSeries[];
  };
}

interface YahooQuoteSeries {
  readonly open?: readonly (number | null)[];
  readonly high?: readonly (number | null)[];
  readonly low?: readonly (number | null)[];
  readonly close?: readonly (number | null)[];
  readonly volume?: readonly (number | null)[];
}
