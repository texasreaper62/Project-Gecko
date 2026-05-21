// Market internals tracker. Maintains a running snapshot of:
//   - SPY direction (intraday change %)
//   - VIX level and direction (proxy via VIX equity quote if subscribed)
//   - Breadth: # of watchlist names UP vs DOWN today
//   - Cumulative volume direction (proxy for institutional flow)
//
// Strategies can subscribe SPY and VIX through the existing stream; this
// module reads from the QuoteCache to stay broker-agnostic.
//
// Provides a CheckResult for the confluence engine: does the broader market
// support the intended trade direction?
//   - LONG equity: prefer SPY +, VIX flat/down, breadth positive
//   - SHORT equity: prefer SPY -, VIX up, breadth negative
//   - LONG SPY 0DTE call: same as LONG equity
//   - SHORT SPY 0DTE put: same as SHORT equity

import { createLogger } from "../core/logger.js";
import type { CheckResult } from "./confluence.js";
import type { QuoteCache } from "../data/quote-cache.js";

const log = createLogger("market-internals");

export interface InternalsSnapshot {
  readonly spyChangePct: number | null;
  readonly vixLevel: number | null;
  readonly vixChangePct: number | null;
  readonly breadthRatio: number | null;        // [0, 1] where 0.5 = balanced
  readonly advancers: number;
  readonly decliners: number;
}

export class MarketInternals {
  private spyOpen: number | null = null;
  private vixOpen: number | null = null;
  private watchlistOpens: Map<string, number> = new Map();

  constructor(
    private readonly quotes: QuoteCache,
    private readonly watchlist: readonly string[],
  ) {}

  // Call once shortly after market open to capture the day's opening prices.
  captureOpens(): void {
    const spy = this.quotes.getEquityPrice("SPY");
    if (spy !== null) this.spyOpen = spy;
    const vix = this.quotes.getEquityPrice("VIX");
    if (vix !== null) this.vixOpen = vix;
    for (const sym of this.watchlist) {
      const p = this.quotes.getEquityPrice(sym);
      if (p !== null) this.watchlistOpens.set(sym, p);
    }
    log.info("Captured opening prices", {
      spy: this.spyOpen,
      vix: this.vixOpen,
      watchlistCount: this.watchlistOpens.size,
    });
  }

  snapshot(): InternalsSnapshot {
    const spyNow = this.quotes.getEquityPrice("SPY");
    const vixNow = this.quotes.getEquityPrice("VIX");
    const spyChangePct = this.spyOpen !== null && spyNow !== null
      ? ((spyNow - this.spyOpen) / this.spyOpen) * 100
      : null;
    const vixChangePct = this.vixOpen !== null && vixNow !== null
      ? ((vixNow - this.vixOpen) / this.vixOpen) * 100
      : null;

    let advancers = 0;
    let decliners = 0;
    for (const [sym, open] of this.watchlistOpens) {
      const now = this.quotes.getEquityPrice(sym);
      if (now === null) continue;
      if (now > open) advancers++;
      else if (now < open) decliners++;
    }
    const total = advancers + decliners;
    const breadthRatio = total > 0 ? advancers / total : null;

    return {
      spyChangePct,
      vixLevel: vixNow,
      vixChangePct,
      breadthRatio,
      advancers,
      decliners,
    };
  }

  evaluate(direction: "LONG" | "SHORT"): CheckResult {
    const snap = this.snapshot();
    let score = 0;
    let count = 0;
    const detail: string[] = [];

    // SPY direction
    if (snap.spyChangePct !== null) {
      count++;
      if (direction === "LONG" && snap.spyChangePct > 0.2) { score += 1; detail.push(`spy+${snap.spyChangePct.toFixed(2)}%`); }
      else if (direction === "LONG" && snap.spyChangePct < -0.2) { score -= 1; detail.push(`spy-${Math.abs(snap.spyChangePct).toFixed(2)}%`); }
      else if (direction === "SHORT" && snap.spyChangePct < -0.2) { score += 1; detail.push(`spy-${Math.abs(snap.spyChangePct).toFixed(2)}%`); }
      else if (direction === "SHORT" && snap.spyChangePct > 0.2) { score -= 1; detail.push(`spy+${snap.spyChangePct.toFixed(2)}%`); }
      else { detail.push(`spy~${snap.spyChangePct.toFixed(2)}%`); }
    }

    // VIX direction (inverse of equity bullishness)
    if (snap.vixChangePct !== null) {
      count++;
      if (direction === "LONG" && snap.vixChangePct < -1) { score += 1; detail.push(`vix-${Math.abs(snap.vixChangePct).toFixed(1)}%`); }
      else if (direction === "LONG" && snap.vixChangePct > 2) { score -= 1; detail.push(`vix+${snap.vixChangePct.toFixed(1)}%`); }
      else if (direction === "SHORT" && snap.vixChangePct > 1) { score += 1; detail.push(`vix+${snap.vixChangePct.toFixed(1)}%`); }
      else if (direction === "SHORT" && snap.vixChangePct < -2) { score -= 1; detail.push(`vix-${Math.abs(snap.vixChangePct).toFixed(1)}%`); }
      else { detail.push(`vix~${snap.vixChangePct.toFixed(1)}%`); }
    }

    // Breadth
    if (snap.breadthRatio !== null) {
      count++;
      if (direction === "LONG" && snap.breadthRatio > 0.6) { score += 1; detail.push(`brth+${(snap.breadthRatio * 100).toFixed(0)}%`); }
      else if (direction === "LONG" && snap.breadthRatio < 0.4) { score -= 1; detail.push(`brth-${(snap.breadthRatio * 100).toFixed(0)}%`); }
      else if (direction === "SHORT" && snap.breadthRatio < 0.4) { score += 1; detail.push(`brth-${(snap.breadthRatio * 100).toFixed(0)}%`); }
      else if (direction === "SHORT" && snap.breadthRatio > 0.6) { score -= 1; detail.push(`brth+${(snap.breadthRatio * 100).toFixed(0)}%`); }
      else { detail.push(`brth~${(snap.breadthRatio * 100).toFixed(0)}%`); }
    }

    const vote = count > 0 ? score / count : 0;
    const confidence = count >= 3 ? 0.8 : count >= 2 ? 0.6 : 0.4;

    return {
      name: "market-internals",
      vote,
      confidence,
      weight: 1.2,
      detail: detail.join(","),
    };
  }
}
