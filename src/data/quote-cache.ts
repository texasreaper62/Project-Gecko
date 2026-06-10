// In-memory last-price cache, filled by the broker stream handler and read
// by the position monitor, regime detector, market internals, and sector
// strength trackers.
//
// Equity prices are keyed by uppercase ticker. Option prices are keyed by
// the exact OSI symbol (already uppercase, embedded spaces significant).
//
// NOTE: this file lives in src/data/ which was once shadowed by the `data/`
// .gitignore entry (runtime JSONL dir). The ignore rule is now root-anchored
// (/data/). If you are reading this on the VPS and the original differs,
// prefer committing the VPS copy.

import type { Instrument } from "../core/types.js";

export class QuoteCache {
  private readonly equity: Map<string, number> = new Map();
  private readonly option: Map<string, number> = new Map();

  setEquityPrice(symbol: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    this.equity.set(symbol.toUpperCase(), price);
  }

  getEquityPrice(symbol: string): number | null {
    return this.equity.get(symbol.toUpperCase()) ?? null;
  }

  setOptionPrice(osiSymbol: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    this.option.set(osiSymbol, price);
  }

  getOptionPrice(osiSymbol: string): number | null {
    return this.option.get(osiSymbol) ?? null;
  }

  // Unified read used by the position monitor.
  getPrice(instrument: Instrument): number | null {
    return instrument.assetClass === "equity"
      ? this.getEquityPrice(instrument.symbol)
      : this.getOptionPrice(instrument.osiSymbol);
  }
}
