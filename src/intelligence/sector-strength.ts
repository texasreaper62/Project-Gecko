// Sector strength signal: confirms or contradicts a trade direction based on
// the underlying's sector ETF performance.
//
// Mechanism: every stock maps to a sector ETF (XLK for tech, XLE for energy,
// etc.). If a LONG signal fires on PLTR but XLK (tech) is down 1%, that's a
// counter-sector trade — lower conviction.
//
// Vote logic for the confluence engine:
//   stock LONG, sector ETF UP > 0.3%   -> vote +0.7 (supporting)
//   stock LONG, sector ETF UP > 0.1%   -> vote +0.3
//   stock LONG, sector ETF DOWN > 0.3% -> vote -0.7 (opposing)
//   stock LONG, sector ETF DOWN > 0.1% -> vote -0.3
//   stock LONG, sector ETF flat        -> vote 0
//   (mirror for SHORT)
//
// Confidence: 0.7 when sector data is fresh, 0 when missing.

import { createLogger } from "../core/logger.js";
import type { CheckResult } from "./confluence.js";
import type { QuoteCache } from "../data/quote-cache.js";

const log = createLogger("sector-strength");

// Map watchlist tickers to their primary sector ETF.
// Curated from US-listed sector ETFs (SPDR Select Sector funds).
const SECTOR_MAP: Record<string, string> = {
  // Tech / software
  PLTR: "XLK", SOFI: "XLK", AFRM: "XLK", UPST: "XLK", RBLX: "XLK",
  SNAP: "XLK", PINS: "XLK", U: "XLK", BBAI: "XLK", AI: "XLK",
  // Energy / crypto-adjacent (treated as energy/financials)
  MARA: "XLF", RIOT: "XLF", CLSK: "XLF",
  HUT: "XLE", BTBT: "XLE", BITF: "XLE",
  // Retail / consumer discretionary
  GME: "XLY", AMC: "XLY", BBBY: "XLY", CHWY: "XLY", DKNG: "XLY",
  // Auto / EV (consumer discretionary)
  NIO: "XLY", XPEV: "XLY", LI: "XLY", RIVN: "XLY", LCID: "XLY", F: "XLY",
  // Financials
  PYPL: "XLF", LMND: "XLF", SQ: "XLF",
  // Healthcare / biotech
  MRNA: "XLV", BNTX: "XLV", CRSP: "XLV", BEAM: "XLV", EDIT: "XLV",
  NTLA: "XLV", VRTX: "XLV",
  // China (no perfect ETF — use SPY as proxy)
  BABA: "SPY", JD: "SPY", PDD: "SPY", BIDU: "SPY", BILI: "SPY",
};

// All sector ETFs the detector watches. Subscribed at startup.
export const SECTOR_ETFS: readonly string[] = ["XLK", "XLF", "XLE", "XLY", "XLV", "XLU", "XLI", "XLB", "XLP", "XLRE"];

export class SectorStrength {
  private opens: Map<string, number> = new Map();

  constructor(private readonly quotes: QuoteCache) {}

  // Capture opening prices for all sector ETFs at session start.
  captureOpens(): void {
    for (const etf of SECTOR_ETFS) {
      const p = this.quotes.getEquityPrice(etf);
      if (p !== null) this.opens.set(etf, p);
    }
    log.info("Sector opens captured", { count: this.opens.size });
  }

  // Lookup which sector ETF a ticker belongs to.
  sectorOf(symbol: string): string | null {
    return SECTOR_MAP[symbol.toUpperCase()] ?? null;
  }

  // Current sector change percent from open.
  sectorChangePct(symbol: string): number | null {
    const etf = this.sectorOf(symbol);
    if (!etf) return null;
    const open = this.opens.get(etf);
    const now = this.quotes.getEquityPrice(etf);
    if (open === undefined || now === null) return null;
    return ((now - open) / open) * 100;
  }

  evaluate(symbol: string, direction: "LONG" | "SHORT"): CheckResult {
    const sec = this.sectorOf(symbol);
    const chg = this.sectorChangePct(symbol);

    if (sec === null || chg === null) {
      return {
        name: "sector-strength",
        vote: 0,
        confidence: 0,
        weight: 0.9,
        detail: sec === null ? "no sector mapped" : "no data",
      };
    }

    // Stronger move = stronger signal. Direction-aware vote.
    let vote: number;
    const absChg = Math.abs(chg);
    if (absChg < 0.1) vote = 0;
    else {
      const sectorBullish = chg > 0;
      const tradeBullish = direction === "LONG";
      const aligned = sectorBullish === tradeBullish;
      const magnitude = absChg >= 0.5 ? 0.7 : absChg >= 0.3 ? 0.5 : 0.3;
      vote = aligned ? magnitude : -magnitude;
    }

    return {
      name: "sector-strength",
      vote,
      confidence: 0.7,
      weight: 0.9,
      detail: `${sec}${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`,
    };
  }
}
