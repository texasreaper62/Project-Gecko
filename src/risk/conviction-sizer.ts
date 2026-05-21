// Conviction-based position sizer with PER-STRATEGY ADAPTIVE TIERS.
//
// Default tiers map conviction -> risk%. But different strategies have
// different conviction-to-win-rate calibrations: ORB at conviction 65 might
// win 75% while mean-reversion at conviction 65 only wins 60%. The bot
// learns the per-strategy realized win rate at each tier and adapts the
// risk% accordingly.
//
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

// Per-strategy + per-tier adaptive risk%.
// strategy -> tier_min_conviction -> adapted_risk_pct
type AdaptedTiersByStrategy = Map<string, Map<number, number>>;

// Minimum trades at a given (strategy, tier) before we adapt that bucket.
const MIN_TRADES_PER_BUCKET_FOR_ADAPT = 5;
// How much can we deviate from the default? At most 2x base risk-pct.
const MAX_TIER_RISK_MULTIPLIER = 2.0;
const MIN_TIER_RISK_MULTIPLIER = 0.3;

export class ConvictionSizer {
  private readonly tiers: readonly ConvictionTier[];
  private adapted: AdaptedTiersByStrategy = new Map();

  constructor(tiers: readonly ConvictionTier[] = DEFAULT_TIERS) {
    this.tiers = [...tiers].sort((a, b) => b.minConviction - a.minConviction);
  }

  // Default mapping (no strategy context). Use this for cold-start / generic.
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

  // Per-strategy adapted risk%. Falls back to default if no adapted value
  // for this (strategy, tier) bucket. Updates come from updateFromOutcomes().
  riskPctForStrategy(strategy: string, conviction: number): number {
    if (!Number.isFinite(conviction)) return this.riskPctFor(conviction);
    for (const tier of this.tiers) {
      if (conviction >= tier.minConviction) {
        const adaptedTier = this.adapted.get(strategy)?.get(tier.minConviction);
        const baseRisk = Math.min(MAX_RISK_PCT_CAP, tier.riskPct);
        if (adaptedTier !== undefined) {
          log.debug("Conviction tier (adapted)", { strategy, conviction, tier: tier.minConviction, baseRiskPct: baseRisk, adaptedRiskPct: adaptedTier });
          return adaptedTier;
        }
        return baseRisk;
      }
    }
    return this.tiers[this.tiers.length - 1].riskPct;
  }

  // Rebuild adapted tiers from the rolling outcomes log. Called by the
  // self-tuner after every closed trade. Scales the default tier risk% by
  // the realized-vs-expected win rate ratio for that (strategy, tier) bucket.
  //
  // Expected win rate assumption per tier (used as a baseline):
  //   60-69 -> 50% baseline (lowest tier, moderate edge)
  //   70-79 -> 60% baseline
  //   80-89 -> 70% baseline
  //   90+   -> 80% baseline
  // If the realized rate exceeds the baseline, scale risk% up; if lower, down.
  updateFromOutcomes(outcomes: ReadonlyArray<{ strategy: string; pnl: number; metadata?: { brainConviction?: number } }>): void {
    // Build (strategy -> tierMin -> [outcomes])
    const buckets = new Map<string, Map<number, { wins: number; total: number }>>();

    for (const o of outcomes) {
      const conv = o.metadata?.brainConviction;
      if (typeof conv !== "number") continue;
      const tier = this.tierMinFor(conv);
      if (tier === null) continue;
      const stratMap = buckets.get(o.strategy) ?? new Map();
      const cell = stratMap.get(tier) ?? { wins: 0, total: 0 };
      cell.total++;
      if (o.pnl > 0) cell.wins++;
      stratMap.set(tier, cell);
      buckets.set(o.strategy, stratMap);
    }

    // Compute adapted risk% per bucket.
    const newAdapted: AdaptedTiersByStrategy = new Map();
    for (const [strategy, stratMap] of buckets) {
      const stratAdapt = new Map<number, number>();
      for (const [tierMin, cell] of stratMap) {
        if (cell.total < MIN_TRADES_PER_BUCKET_FOR_ADAPT) continue;
        const realizedWR = cell.wins / cell.total;
        const expectedWR = expectedWinRateForTier(tierMin);
        const baseRisk = this.defaultRiskFor(tierMin);
        // Scale by realized/expected. Capped to [MIN_TIER_RISK_MULTIPLIER, MAX_TIER_RISK_MULTIPLIER].
        const multiplier = clampRange(realizedWR / expectedWR, MIN_TIER_RISK_MULTIPLIER, MAX_TIER_RISK_MULTIPLIER);
        const adaptedRisk = Math.min(MAX_RISK_PCT_CAP, baseRisk * multiplier);
        stratAdapt.set(tierMin, adaptedRisk);
        log.info("Adapted conviction tier", {
          strategy, tier: tierMin, realizedWR: (realizedWR * 100).toFixed(0) + "%",
          expectedWR: (expectedWR * 100).toFixed(0) + "%", baseRisk: baseRisk.toFixed(2),
          adaptedRisk: adaptedRisk.toFixed(2), n: cell.total,
        });
      }
      if (stratAdapt.size > 0) newAdapted.set(strategy, stratAdapt);
    }
    this.adapted = newAdapted;
  }

  // Get the tier minimum that this conviction maps to.
  private tierMinFor(conviction: number): number | null {
    for (const tier of this.tiers) {
      if (conviction >= tier.minConviction) return tier.minConviction;
    }
    return null;
  }

  private defaultRiskFor(tierMin: number): number {
    for (const tier of this.tiers) {
      if (tier.minConviction === tierMin) return tier.riskPct;
    }
    return DEFAULT_TIERS[DEFAULT_TIERS.length - 1].riskPct;
  }
}

function expectedWinRateForTier(tierMin: number): number {
  if (tierMin >= 90) return 0.80;
  if (tierMin >= 80) return 0.70;
  if (tierMin >= 70) return 0.60;
  if (tierMin >= 60) return 0.50;
  return 0.40;
}

function clampRange(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, n));
}
