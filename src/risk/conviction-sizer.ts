// Conviction-based position sizer.
//
// The brain returns a 0-100 conviction score on every trade. Higher conviction
// = the bot is more confident in the edge = position size scales up.
//
// Tiers tuned from shadow data (avg loss ~8R due to gap fills) so that
// worst-case single-trade drawdown stays under ~30% even at top tier:
//
//   60-69  -> 1.0%   (base — minimum acceptable conviction)
//   70-79  -> 1.5%   (moderate conviction)
//   80-89  -> 2.5%   (high conviction)
//   90-100 -> 3.5%   (very high conviction — rare)
//
// The mapping is a STEP FUNCTION rather than linear so each tier represents
// a meaningfully different risk decision. Operators can tune the boundaries
// or disable conviction sizing via config.

import { createLogger } from "../core/logger.js";

const log = createLogger("conviction-sizer");

export interface ConvictionTier {
  readonly minConviction: number;
  readonly riskPct: number;
}

const DEFAULT_TIERS: readonly ConvictionTier[] = [
  { minConviction: 90, riskPct: 3.5 },
  { minConviction: 80, riskPct: 2.5 },
  { minConviction: 70, riskPct: 1.5 },
  { minConviction: 60, riskPct: 1.0 },
  { minConviction: 0,  riskPct: 0.5 },     // fallback, should never hit if brain rejected
];

const MAX_RISK_PCT_CAP = 5.0;

export class ConvictionSizer {
  private readonly tiers: readonly ConvictionTier[];

  constructor(tiers: readonly ConvictionTier[] = DEFAULT_TIERS) {
    this.tiers = [...tiers].sort((a, b) => b.minConviction - a.minConviction);
  }

  // Return the risk-percent recommended for this conviction, clamped to the cap.
  riskPctFor(conviction: number): number {
    if (!Number.isFinite(conviction)) return DEFAULT_TIERS[DEFAULT_TIERS.length - 1].riskPct;
    for (const tier of this.tiers) {
      if (conviction >= tier.minConviction) {
        const capped = Math.min(MAX_RISK_PCT_CAP, tier.riskPct);
        log.debug("Conviction tier", { conviction, tier: tier.minConviction, riskPct: capped });
        return capped;
      }
    }
    return this.tiers[this.tiers.length - 1].riskPct;
  }
}
