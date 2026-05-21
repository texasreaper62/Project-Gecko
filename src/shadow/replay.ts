// Replay engine for the shadow harness.
//
// Reads historical bars (Yahoo, cached jsonl, or Schwab if available) for a
// list of symbols and replays them as NormalizedTicks into a ShadowBroker.
//
// The replay can run in two modes:
//   - "realtime": one tick per X ms with system clock advancing naturally
//   - "fast": tick-by-tick replay as fast as possible, with the global "now"
//     being advanced by the bar timestamps so strategies see the right ET
//     time for window logic
//
// In fast mode we monkey-patch Date.now in the harness CLI so the bot's
// time helpers (etParts etc.) report the historical timestamp rather than
// the wall clock. This is what makes the test deterministic and quick.

import { createLogger } from "../core/logger.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import { etParts } from "../utils/time.js";
import type { Bar } from "../core/types.js";
import type { NormalizedTick } from "../brokers/broker.js";
import type { ShadowBroker } from "./shadow-broker.js";

const log = createLogger("replay");

export interface ReplayOptions {
  readonly symbols: readonly string[];
  readonly interval: "1m" | "5m" | "15m";
  readonly lookbackDays: number;
  readonly broker: ShadowBroker;
  readonly mode: "fast" | "realtime";
  readonly tickIntervalMs?: number;     // realtime mode pacing
  // Inject a custom Date.now so strategies see historical timestamps.
  readonly setNow?: (ms: number) => void;
  // Called when the replay crosses an ET date boundary. Receives the new
  // YYYY-MM-DD date string. Use this to refresh per-day strategy state
  // (e.g. ORB candidates with the day's real gap data).
  readonly onNewDay?: (etDate: string) => Promise<void>;
}

export class ReplayEngine {
  constructor(private readonly opts: ReplayOptions) {}

  async run(): Promise<{ totalTicks: number; durationMs: number }> {
    const yahoo = new YahooHistoricalBars();
    const now = Date.now();

    // Fetch bars per symbol.
    const bySymbol: Map<string, Bar[]> = new Map();
    for (const sym of this.opts.symbols) {
      const bars = await yahoo.fetch({
        symbol: sym,
        interval: this.opts.interval,
        startMs: now - this.opts.lookbackDays * 24 * 60 * 60 * 1000,
        endMs: now,
        includePrePost: true,
      });
      bySymbol.set(sym, [...bars]);
      log.info("Loaded shadow bars", { sym, count: bars.length });
    }

    // Interleave all symbols' bars by timestamp.
    const merged: Array<Bar> = [];
    for (const [, bars] of bySymbol) for (const b of bars) merged.push(b);
    merged.sort((a, b) => a.timestamp - b.timestamp);
    log.info("Merged tick stream", { totalBars: merged.length });

    // Use a wall-clock reference for duration timing (Date.now is monkey-
    // patched by the harness to virtual time).
    const startWall = performance.now();
    let emitted = 0;
    let lastDate = "";

    for (const bar of merged) {
      // Set virtual clock to the bar's timestamp so etParts() / market-hours
      // helpers see the right ET wall-clock.
      this.opts.setNow?.(bar.timestamp);
      const date = etParts(bar.timestamp).date;
      if (date !== lastDate) {
        if (this.opts.onNewDay) {
          try { await this.opts.onNewDay(date); }
          catch (err) { log.warn("onNewDay handler failed", { date, error: err instanceof Error ? err.message : String(err) }); }
        }
        lastDate = date;
      }

      const isEquity = bar.symbol.length <= 6 && !bar.symbol.includes(":");
      const kind = isEquity ? "equity-tick" : "option-tick";

      // Convert one OHLC bar into a sequence of ticks. Simplest: emit close
      // as the last value. Optional: emit open/high/low as additional ticks
      // to give strategies more granularity within the bar.
      const ticks: NormalizedTick[] = [
        { symbol: bar.symbol, last: bar.close, timestamp: bar.timestamp, volume: bar.volume },
      ];
      this.opts.broker.emitTick(kind, ticks);
      emitted++;

      if (this.opts.mode === "realtime" && this.opts.tickIntervalMs) {
        await sleep(this.opts.tickIntervalMs);
      }
    }

    const durationMs = Math.round(performance.now() - startWall);
    log.info("Replay complete", { emitted, durationMs });
    return { totalTicks: emitted, durationMs };
  }
}

// etParts is referenced for downstream consumers; keep the import live.
void etParts;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
