import type { Instrument } from "../core/types.js";

// In-memory last-price cache keyed by equity ticker or OSI option symbol.
// Fed by the streaming layer (LEVELONE_EQUITIES / LEVELONE_OPTIONS handlers)
// and read by strategies, position-monitor, regime/internals/sector trackers.
//
// Equity keys are normalized to uppercase. Option keys are the raw 21-char
// OSI symbol (no normalization).
export class QuoteCache {
  private readonly equityPrices = new Map<string, number>();
  private readonly optionPrices = new Map<string, number>();

  setEquityPrice(symbol: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    this.equityPrices.set(symbol.toUpperCase(), price);
  }

  setOptionPrice(osiSymbol: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    this.optionPrices.set(osiSymbol, price);
  }

  getEquityPrice(symbol: string): number | null {
    const p = this.equityPrices.get(symbol.toUpperCase());
    return p === undefined ? null : p;
  }

  getOptionPrice(osiSymbol: string): number | null {
    const p = this.optionPrices.get(osiSymbol);
    return p === undefined ? null : p;
  }

  getPrice(instrument: Instrument): number | null {
    const p = instrument.assetClass === "equity"
      ? this.equityPrices.get(instrument.symbol.toUpperCase())
      : this.optionPrices.get(instrument.osiSymbol);
    return p === undefined ? null : p;
  }
}
