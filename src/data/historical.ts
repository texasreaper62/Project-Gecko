// Historical bar fetcher with an in-memory cache.
//
// Consumers: the premarket scanner (previous-close lookup), the Schwab
// backtest runner (minute + daily bars), and the multi-timeframe validator
// (synchronous reads via peekCache).
//
// The source is either the raw SchwabRest client (BROKER=schwab and the
// Schwab backtest CLI, one symbol per call against /pricehistory) or any
// Broker adapter (BROKER=ibkr path, /iserver/marketdata/history under the
// hood). Both are normalized to the shared Bar shape.
//
// NOTE: this module was reconstructed after the original src/data/ files
// were lost to an unanchored `data/` .gitignore entry. If the VPS copy
// differs, prefer committing the VPS original.

import { createLogger } from "../core/logger.js";
import { isBroker, type Broker, type HistoricalBarsQuery } from "../brokers/broker.js";
import type { SchwabRest } from "../brokers/schwab/rest.js";
import type { Bar } from "../core/types.js";

const log = createLogger("historical");

export interface HistoricalFetchParams {
  readonly symbol: string;
  readonly frequencyType: "minute" | "daily";
  readonly frequency: number;          // minutes per bar for "minute"; 1 for "daily"
  readonly startMs: number;
  readonly endMs: number;
  readonly extendedHours?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class HistoricalBars {
  // Keyed by symbol|frequencyType|frequency; bars deduped by timestamp, ascending.
  private readonly cache: Map<string, Bar[]> = new Map();

  constructor(private readonly source: SchwabRest | Broker) {}

  async fetch(params: HistoricalFetchParams): Promise<readonly Bar[]> {
    const bars = isBroker(this.source)
      ? await this.fetchViaBroker(this.source, params)
      : await this.fetchViaSchwab(this.source, params);
    this.mergeIntoCache(cacheKey(params.symbol, params.frequencyType, params.frequency), bars);
    return bars.filter((b) => b.timestamp >= params.startMs && b.timestamp <= params.endMs);
  }

  // Synchronous read of whatever is already cached for the range. The
  // multi-timeframe validator calls this from a hot path and tolerates an
  // empty result when nothing has been fetched yet.
  peekCache(
    symbol: string,
    frequencyType: string,
    frequency: number,
    startMs: number,
    endMs: number,
  ): readonly Bar[] {
    const rows = this.cache.get(cacheKey(symbol, frequencyType, frequency));
    if (!rows) return [];
    return rows.filter((b) => b.timestamp >= startMs && b.timestamp <= endMs);
  }

  // ----- Internals -----

  private async fetchViaSchwab(rest: SchwabRest, params: HistoricalFetchParams): Promise<Bar[]> {
    // Schwab requires a periodType compatible with the frequencyType even
    // when explicit startDate/endDate are supplied.
    const history = await rest.getPriceHistory({
      symbol: params.symbol,
      periodType: params.frequencyType === "minute" ? "day" : "month",
      frequencyType: params.frequencyType,
      frequency: params.frequency,
      startDate: params.startMs,
      endDate: params.endMs,
      needExtendedHoursData: params.extendedHours ?? false,
    });
    const symbol = params.symbol.toUpperCase();
    return history.candles.map((c) => ({
      symbol,
      timestamp: c.datetime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }

  private async fetchViaBroker(broker: Broker, params: HistoricalFetchParams): Promise<Bar[]> {
    // Broker lookback is relative to now, so size it from startMs to today.
    const days = Math.max(1, Math.ceil((Date.now() - params.startMs) / DAY_MS));
    const query: HistoricalBarsQuery = {
      symbol: params.symbol,
      frequency: brokerFrequency(params.frequencyType, params.frequency),
      lookback: `${days}d`,
      extendedHours: params.extendedHours,
    };
    const bars = await broker.getHistoricalBars(query);
    return [...bars];
  }

  private mergeIntoCache(key: string, bars: readonly Bar[]): void {
    if (bars.length === 0) return;
    const existing = this.cache.get(key);
    if (!existing) {
      this.cache.set(key, [...bars].sort((a, b) => a.timestamp - b.timestamp));
      return;
    }
    const byTs = new Map<number, Bar>();
    for (const b of existing) byTs.set(b.timestamp, b);
    for (const b of bars) byTs.set(b.timestamp, b);
    const merged = [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
    this.cache.set(key, merged);
    log.debug("Bar cache merged", { key, total: merged.length });
  }
}

function cacheKey(symbol: string, frequencyType: string, frequency: number): string {
  return `${symbol.toUpperCase()}|${frequencyType}|${frequency}`;
}

function brokerFrequency(
  frequencyType: "minute" | "daily",
  frequency: number,
): HistoricalBarsQuery["frequency"] {
  if (frequencyType === "daily") return "1d";
  if (frequency <= 1) return "1min";
  if (frequency <= 5) return "5min";
  if (frequency <= 15) return "15min";
  return "1h";
}
