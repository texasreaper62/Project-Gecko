// Premarket gap scanner. Runs once at 9:00 ET each trading day.
//
// Strategy MVP approach: use a fixed watchlist (loaded from a file) and
// compute gap % from previous regular-session close vs current premarket
// price. Schwab returns extended-hours quotes via getQuotes during
// premarket. Previous close comes from the daily price history.
//
// Why fixed watchlist instead of a screener: Schwab does not expose a
// reliable top-movers endpoint via REST. The streaming SCREENER_EQUITY
// service exists but is more complexity than we need for MVP. A 100-200
// symbol watchlist of liquid stocks $5-50 covers most ORB candidates.
//
// Watchlist file: data/watchlist.txt (one ticker per line, # comments OK).
// Falls back to a built-in default if the file is missing.

import * as fs from "node:fs";
import { createLogger } from "../core/logger.js";
import type { AppConfig, EquityInstrument } from "../core/types.js";
import type { SchwabRest } from "../brokers/schwab/rest.js";
import type { HistoricalBars } from "../data/historical.js";

const log = createLogger("premarket-scanner");

const WATCHLIST_FILE = "data/watchlist.txt";

// Built-in default watchlist: the high-vol gappers that produced the best
// shadow results (see scenario E: 60% win, PF 2.09, +20.7% / 30 days).
//
// Selectivity > breadth: tightening from 14 symbols to 5 INCREASED the
// strategy's monthly return from 11.5% to 20.7%. Bigger universes dilute
// the AI gates with marginal setups.
//
// Tier 1 (high-vol, included by default): names with 2%+ weekly avg gaps
// and >$5M average premarket dollar volume.
// Tier 2 (commented out): broader universe — uncomment if conviction
// thresholds get high enough to filter the lower-quality setups.
const DEFAULT_WATCHLIST: readonly string[] = [
  // Tier 1: high-vol gappers (validated as best in shadow scenario E)
  "PLTR", "MARA", "RIOT", "RIVN", "SOFI", "NIO", "F",
  // Tier 2 candidates (currently disabled):
  // "AFRM", "UPST", "RBLX", "SNAP", "PINS", "U", "BBAI", "AI",
  // "MRNA", "BNTX", "CRSP", "BEAM", "EDIT", "NTLA", "VRTX",
  // "CLSK", "HUT", "BTBT", "BITF",
  // "GME", "AMC", "BBBY", "BB", "NOK", "SPCE", "WISH", "CLOV",
  // "XPEV", "LI", "LCID",
  // "PYPL", "LMND", "SQ",
  // "BABA", "JD", "PDD", "BIDU", "BILI",
  // "DKNG", "CHWY", "ROKU", "SHOP", "Z", "ZM",
];

export interface GapCandidate {
  readonly instrument: EquityInstrument;
  readonly previousClose: number;
  readonly premarketPrice: number;
  readonly gapPct: number;
  readonly premarketVolume: number;
  readonly direction: "UP" | "DOWN";
}

export class PremarketScanner {
  constructor(
    private readonly config: AppConfig,
    private readonly rest: SchwabRest,
    private readonly historical: HistoricalBars,
  ) {}

  loadWatchlist(): readonly string[] {
    try {
      if (fs.existsSync(WATCHLIST_FILE)) {
        const text = fs.readFileSync(WATCHLIST_FILE, "utf-8");
        const lines = text.split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && !s.startsWith("#"))
          .map((s) => s.toUpperCase());
        if (lines.length > 0) {
          log.info("Loaded watchlist from file", { count: lines.length });
          return lines;
        }
      }
    } catch (err) {
      log.warn("Failed to read watchlist file, using default", { error: errMsg(err) });
    }
    return DEFAULT_WATCHLIST;
  }

  async scan(): Promise<readonly GapCandidate[]> {
    const watchlist = this.loadWatchlist();
    log.info("Premarket scan starting", { universeSize: watchlist.length });

    // Schwab getQuotes can take many symbols at once. Batch in chunks of 100.
    const quotes = await this.batchQuotes(watchlist, 100);

    // For previous close we need 2 daily bars (today's incomplete + prior close).
    // Run in parallel with a small concurrency cap to avoid rate limits.
    const candidates: GapCandidate[] = [];
    const concurrency = 8;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < watchlist.length) {
        const i = cursor++;
        const symbol = watchlist[i];
        const q = quotes[symbol];
        if (!q || !q.quote || !Number.isFinite(q.quote.lastPrice) || q.quote.lastPrice <= 0) continue;

        try {
          const prevClose = await this.fetchPreviousClose(symbol);
          if (prevClose <= 0) continue;

          const premarketPrice = q.quote.lastPrice;
          const gapPct = (premarketPrice - prevClose) / prevClose * 100;
          const absGap = Math.abs(gapPct);
          const premarketVolume = q.quote.totalVolume ?? 0;

          if (absGap < this.config.orbMinGapPct) continue;
          if (premarketVolume < this.config.orbMinPremarketVolume) continue;
          if (premarketPrice < this.config.orbMinPrice || premarketPrice > this.config.orbMaxPrice) continue;

          candidates.push({
            instrument: { assetClass: "equity", symbol },
            previousClose: prevClose,
            premarketPrice,
            gapPct,
            premarketVolume,
            direction: gapPct > 0 ? "UP" : "DOWN",
          });
        } catch (err) {
          log.debug("Symbol scan failed", { symbol, error: errMsg(err) });
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    // Sort by absolute gap descending (biggest movers first).
    candidates.sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));

    log.info("Premarket scan complete", {
      universeSize: watchlist.length,
      candidates: candidates.length,
      topGap: candidates[0] ? candidates[0].gapPct.toFixed(2) : "n/a",
    });

    return candidates;
  }

  // ----- Internals -----

  private async batchQuotes(symbols: readonly string[], chunkSize: number): Promise<Record<string, { quote: { lastPrice: number; totalVolume?: number } }>> {
    const merged: Record<string, { quote: { lastPrice: number; totalVolume?: number } }> = {};
    for (let i = 0; i < symbols.length; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);
      try {
        const batch = await this.rest.getQuotes(chunk);
        for (const [sym, q] of Object.entries(batch)) {
          merged[sym] = q as { quote: { lastPrice: number; totalVolume?: number } };
        }
      } catch (err) {
        log.warn("Quote batch failed", {
          chunk: chunk.slice(0, 5).join(",") + (chunk.length > 5 ? "..." : ""),
          error: errMsg(err),
        });
      }
    }
    return merged;
  }

  private async fetchPreviousClose(symbol: string): Promise<number> {
    // Fetch daily bars for the last 5 days; use the most recent fully-closed
    // session as previous close. This avoids weekend / holiday edge cases.
    const end = Date.now();
    const start = end - 7 * 24 * 60 * 60 * 1000;
    const bars = await this.historical.fetch({
      symbol,
      frequencyType: "daily",
      frequency: 1,
      startMs: start,
      endMs: end,
      extendedHours: false,
    });
    if (bars.length === 0) return 0;
    // Last fully-closed daily bar is bars[length-1] when called premarket.
    return bars[bars.length - 1].close;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
