// Regime detector. Classifies the current market into one of four states
// so the strategy stack can adjust:
//
//   TRENDING_LOW_VOL    SPY moving directionally, VIX < 18.
//                        Best for momentum/ORB. Size up.
//   TRENDING_HIGH_VOL   SPY moving directionally, VIX >= 18.
//                        Profitable but volatile. Normal size.
//   CHOPPY_LOW_VOL      SPY range-bound, VIX < 18.
//                        Bad for ORB; good for mean reversion. Reduce momentum size.
//   CHOPPY_HIGH_VOL     SPY range-bound, VIX >= 18.
//                        Whipsaw risk. Cut all sizes. Skip catalysts.
//
// Signals used (all from QuoteCache and recent SPY bars):
//   - VIX level (or estimated from SPY's recent realized vol if no VIX)
//   - SPY % from intraday open
//   - Realized SPY volatility (stdev of 5-min returns over last hour)
//   - Trendiness: |close - vwap| / atr
//
// The regime is recomputed every minute and exposed as a snapshot. Strategy
// signal evaluations should read the latest regime before sizing.

import { createLogger } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import type { QuoteCache } from "../data/quote-cache.js";

const log = createLogger("regime");

export type Regime = "TRENDING_LOW_VOL" | "TRENDING_HIGH_VOL" | "CHOPPY_LOW_VOL" | "CHOPPY_HIGH_VOL";

export interface RegimeSnapshot {
  readonly regime: Regime;
  readonly vixLevel: number | null;
  readonly spyChangePct: number | null;
  readonly realizedVolPct: number | null;     // annualized
  readonly trendiness: number | null;          // [0, ~3]; high = trending
  readonly sizeMultiplier: number;             // [0.25, 1.5]
  readonly skipMomentum: boolean;
  readonly skipMeanReversion: boolean;
  readonly timestamp: number;
}

interface BarSnapshot {
  readonly timestamp: number;
  readonly price: number;
}

export class RegimeDetector {
  private spyOpen: number | null = null;
  private vixOpen: number | null = null;
  private spyBars: BarSnapshot[] = [];
  private latestSnapshot: RegimeSnapshot;

  constructor(private readonly quotes: QuoteCache) {
    this.latestSnapshot = {
      regime: "CHOPPY_LOW_VOL",
      vixLevel: null, spyChangePct: null, realizedVolPct: null, trendiness: null,
      sizeMultiplier: 1.0, skipMomentum: false, skipMeanReversion: false,
      timestamp: Date.now(),
    };
  }

  // Call at session open to baseline today's reference prices.
  captureOpens(): void {
    this.spyOpen = this.quotes.getEquityPrice("SPY");
    this.vixOpen = this.quotes.getEquityPrice("VIX");
    this.spyBars = [];
    log.info("Regime detector reset for new session", { spyOpen: this.spyOpen, vixOpen: this.vixOpen });
  }

  // Push a SPY price sample. Should be called from the stream handler.
  recordSpy(price: number, ts: number = Date.now()): void {
    if (!Number.isFinite(price) || price <= 0) return;
    if (this.spyOpen === null) this.spyOpen = price;
    this.spyBars.push({ timestamp: ts, price });
    // Keep last ~60 minutes of 5-second resolution = 720 samples.
    if (this.spyBars.length > 720) this.spyBars.shift();
  }

  // Recompute and cache the snapshot. Cheap to call every minute.
  refresh(): RegimeSnapshot {
    const spyNow = this.quotes.getEquityPrice("SPY");
    const vixNow = this.quotes.getEquityPrice("VIX");
    const spyChangePct = this.spyOpen !== null && spyNow !== null
      ? ((spyNow - this.spyOpen) / this.spyOpen) * 100
      : null;
    const vixLevel = vixNow;

    const realizedVolPct = this.computeRealizedVol();
    const trendiness = this.computeTrendiness();

    const hiVol = vixLevel !== null
      ? vixLevel >= 18
      : (realizedVolPct !== null ? realizedVolPct >= 20 : false);
    const trending = trendiness !== null && trendiness >= 1.0;

    let regime: Regime;
    if (trending && !hiVol) regime = "TRENDING_LOW_VOL";
    else if (trending && hiVol) regime = "TRENDING_HIGH_VOL";
    else if (!trending && !hiVol) regime = "CHOPPY_LOW_VOL";
    else regime = "CHOPPY_HIGH_VOL";

    const { sizeMultiplier, skipMomentum, skipMeanReversion } = regimeAdjustments(regime);

    this.latestSnapshot = {
      regime, vixLevel, spyChangePct, realizedVolPct, trendiness,
      sizeMultiplier, skipMomentum, skipMeanReversion,
      timestamp: Date.now(),
    };
    return this.latestSnapshot;
  }

  get(): RegimeSnapshot { return this.latestSnapshot; }

  // Realized vol estimated from 5-min returns over the last hour.
  // Standard deviation annualized: sigma * sqrt(252 * 78) for 5-min bars.
  private computeRealizedVol(): number | null {
    if (this.spyBars.length < 10) return null;
    // Sample every ~5 minutes (300 seconds) from the bar history.
    const samples: number[] = [];
    let lastTs = this.spyBars[0].timestamp;
    let lastPrice = this.spyBars[0].price;
    for (const bar of this.spyBars) {
      if (bar.timestamp - lastTs >= 300_000) {
        samples.push(Math.log(bar.price / lastPrice));
        lastTs = bar.timestamp;
        lastPrice = bar.price;
      }
    }
    if (samples.length < 3) return null;
    const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
    const variance = samples.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, samples.length - 1);
    const sigma = Math.sqrt(variance);
    // 5-min returns -> annualized: 252 trading days * 78 bars/day = 19,656
    const annualized = sigma * Math.sqrt(19_656) * 100;
    return annualized;
  }

  // Trendiness: |current - average| / standard deviation of recent prices.
  // High value = price is far from its recent mean = trending.
  private computeTrendiness(): number | null {
    if (this.spyBars.length < 20) return null;
    const prices = this.spyBars.map((b) => b.price);
    const mean = prices.reduce((s, x) => s + x, 0) / prices.length;
    const variance = prices.reduce((s, x) => s + (x - mean) ** 2, 0) / prices.length;
    const sigma = Math.sqrt(variance);
    if (sigma === 0) return null;
    const current = prices[prices.length - 1];
    return Math.abs(current - mean) / sigma;
  }
}

function regimeAdjustments(regime: Regime): { sizeMultiplier: number; skipMomentum: boolean; skipMeanReversion: boolean } {
  switch (regime) {
    case "TRENDING_LOW_VOL":
      return { sizeMultiplier: 1.3, skipMomentum: false, skipMeanReversion: true };
    case "TRENDING_HIGH_VOL":
      return { sizeMultiplier: 1.0, skipMomentum: false, skipMeanReversion: true };
    case "CHOPPY_LOW_VOL":
      return { sizeMultiplier: 0.6, skipMomentum: true, skipMeanReversion: false };
    case "CHOPPY_HIGH_VOL":
      return { sizeMultiplier: 0.4, skipMomentum: true, skipMeanReversion: true };
  }
}

// etParts is intentionally imported so consumers can extend the snapshot
// with time-of-day context easily.
void etParts;
