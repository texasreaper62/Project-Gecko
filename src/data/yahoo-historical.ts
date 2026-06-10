// Yahoo Finance historical bars (free, no key). Powers the backtest and
// shadow paths so strategy validation never burns broker rate limits.
//
// Endpoint: GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
//   ?period1={sec}&period2={sec}&interval={1m|5m|15m|1h|1d}&includePrePost={bool}
// Yahoo limits: 1m bars only within the last ~30 days and ~7 days per
// request; 5m/15m within ~60 days. Callers already size lookbacks to fit.
//
// On-disk cache (default on) lives under data/yahoo-cache/, keyed by
// symbol + interval + prePost + UTC-day-bucketed range, so repeat runs on
// the same day reuse the download. Pass cache:false to force a fresh pull
// (e.g. to capture premarket bars added since the cached copy).
//
// NOTE: this module was reconstructed after the original src/data/ files
// were lost to an unanchored `data/` .gitignore entry. If the VPS copy
// differs, prefer committing the VPS original.

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import { fetchWithRetry } from "../utils/retry.js";
import type { Bar } from "../core/types.js";

const log = createLogger("yahoo-historical");

const BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const CACHE_DIR = path.join("data", "yahoo-cache");
const DAY_MS = 24 * 60 * 60 * 1000;

export type YahooInterval = "1m" | "5m" | "15m" | "1h" | "1d";

export interface YahooFetchParams {
  readonly symbol: string;
  readonly interval: YahooInterval;
  readonly startMs: number;
  readonly endMs: number;
  readonly includePrePost?: boolean;
  readonly cache?: boolean;            // default true
}

interface YahooChartResponse {
  readonly chart?: {
    readonly result?: readonly {
      readonly timestamp?: readonly number[];
      readonly indicators?: {
        readonly quote?: readonly {
          readonly open?: readonly (number | null)[];
          readonly high?: readonly (number | null)[];
          readonly low?: readonly (number | null)[];
          readonly close?: readonly (number | null)[];
          readonly volume?: readonly (number | null)[];
        }[];
      };
    }[];
    readonly error?: { readonly code?: string; readonly description?: string } | null;
  };
}

export class YahooHistoricalBars {
  async fetch(params: YahooFetchParams): Promise<readonly Bar[]> {
    const useCache = params.cache !== false;
    const file = cacheFile(params);

    if (useCache) {
      const cached = readCache(file);
      if (cached) {
        log.debug("Yahoo cache hit", { symbol: params.symbol, interval: params.interval, count: cached.length });
        return cached;
      }
    }

    const qs = new URLSearchParams({
      period1: String(Math.floor(params.startMs / 1000)),
      period2: String(Math.floor(params.endMs / 1000)),
      interval: params.interval,
      includePrePost: String(params.includePrePost ?? false),
    });
    const url = `${BASE_URL}/${encodeURIComponent(params.symbol.toUpperCase())}?${qs.toString()}`;

    const resp = await fetchWithRetry(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Yahoo chart HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as YahooChartResponse;
    if (data.chart?.error) {
      throw new Error(`Yahoo chart error: ${data.chart.error.description ?? data.chart.error.code ?? "unknown"}`);
    }

    const bars = parseBars(params.symbol, data);
    log.info("Yahoo bars fetched", { symbol: params.symbol, interval: params.interval, count: bars.length });

    if (useCache && bars.length > 0) writeCache(file, bars);
    return bars;
  }
}

function parseBars(symbol: string, data: YahooChartResponse): Bar[] {
  const result = data.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote || timestamps.length === 0) return [];

  const sym = symbol.toUpperCase();
  const bars: Bar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    // Yahoo pads halted/empty intervals with nulls. Skip those rows.
    if (open == null || high == null || low == null || close == null) continue;
    bars.push({
      symbol: sym,
      timestamp: timestamps[i] * 1000,
      open,
      high,
      low,
      close,
      volume: quote.volume?.[i] ?? 0,
    });
  }
  return bars;
}

// Cache key bucketed to UTC days so repeat runs within the same day hit the
// same file even though callers compute ranges from Date.now().
function cacheFile(params: YahooFetchParams): string {
  const dayStart = Math.floor(params.startMs / DAY_MS);
  const dayEnd = Math.floor(params.endMs / DAY_MS);
  const pp = params.includePrePost ? "pp1" : "pp0";
  const name = `${params.symbol.toUpperCase()}_${params.interval}_${pp}_${dayStart}_${dayEnd}.json`;
  return path.join(CACHE_DIR, name);
}

function readCache(file: string): Bar[] | null {
  try {
    if (!fs.existsSync(file)) return null;
    const rows = JSON.parse(fs.readFileSync(file, "utf-8")) as Bar[];
    return Array.isArray(rows) && rows.length > 0 ? rows : null;
  } catch (err) {
    log.warn("Yahoo cache read failed, refetching", { file, error: errMsg(err) });
    return null;
  }
}

function writeCache(file: string, bars: readonly Bar[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(bars));
  } catch (err) {
    log.warn("Yahoo cache write failed", { file, error: errMsg(err) });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
