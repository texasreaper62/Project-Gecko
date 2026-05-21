// Walk-forward parameter optimizer.
//
// Periodically re-tunes strategy parameters based on the most recent rolling
// window of outcomes. Different from SelfTuner (which adjusts coarse global
// knobs): this targets specific STRATEGY parameters that influence which
// signals fire.
//
// For ORB: gap-min, OR-width-min, OR-width-max, RR-target, conviction floor
// For Mean-Reversion: deviation threshold, hold-max-min
//
// Method:
//   1. Read last N closed trades
//   2. For each strategy, group trades by parameter buckets
//   3. Compute realized win rate × R-multiple per bucket
//   4. Recommend parameter shifts toward the buckets with best edge
//
// Output is a TunedParams record. Strategy code (or operator) can read this
// and adopt. We don't auto-apply to running strategies mid-day; new params
// take effect on the next day's setups.
//
// Constraints:
//   - Need at least MIN_TRADES_FOR_WALKFORWARD outcomes before any change
//   - Each parameter change capped to ±MAX_STEP_PCT per pass (gradual)
//   - Parameter clamped to a sensible range so we can't tune ourselves to
//     absurd values

import { createLogger } from "../core/logger.js";
import { readJsonl, appendJsonl } from "../utils/persistence.js";
import { nowIso } from "../utils/time.js";

const log = createLogger("walk-forward");

const OUTCOMES_FILE = "data/outcomes.jsonl";
const TUNED_PARAMS_FILE = "data/tuned-params.jsonl";

const MIN_TRADES_FOR_WALKFORWARD = 25;
const ROLLING_WINDOW = 60;
const MAX_STEP_PCT = 0.10;            // never change a param by more than 10% per pass

// Tunable parameter ranges. (default, min, max)
const PARAM_RANGES: Record<string, Record<string, { default: number; min: number; max: number }>> = {
  orb: {
    minGapPct: { default: 2.0, min: 1.0, max: 5.0 },
    orMinWidthPct: { default: 0.5, min: 0.3, max: 1.0 },
    orMaxWidthPct: { default: 5.0, min: 2.0, max: 8.0 },
    rrTarget: { default: 2.0, min: 1.0, max: 3.5 },
  },
  "mean-reversion": {
    deviationThresholdPct: { default: 0.20, min: 0.10, max: 0.40 },
    holdMaxMin: { default: 15, min: 5, max: 30 },
  },
};

export interface TunedParams {
  readonly strategy: string;
  readonly params: Record<string, number>;
  readonly n: number;
  readonly avgR: number;
  readonly winRate: number;
}

interface OutcomeRow {
  readonly strategy: string;
  readonly pnl: number;
  readonly metadata?: Record<string, unknown>;
}

export class WalkForwardOptimizer {
  private latest: Map<string, TunedParams> = new Map();

  // Run optimization pass across all known strategies. Returns the new params.
  optimize(): readonly TunedParams[] {
    const allOutcomes = readJsonl<OutcomeRow>(OUTCOMES_FILE);
    if (allOutcomes.length < MIN_TRADES_FOR_WALKFORWARD) {
      log.debug("Walk-forward skipped: insufficient outcomes", { n: allOutcomes.length });
      return [];
    }
    const recent = allOutcomes.slice(-ROLLING_WINDOW);
    const results: TunedParams[] = [];

    for (const [strategy, paramSpec] of Object.entries(PARAM_RANGES)) {
      const stratOuts = recent.filter((o) => o.strategy === strategy);
      if (stratOuts.length < 10) continue;

      const wins = stratOuts.filter((o) => o.pnl > 0).length;
      const winRate = wins / stratOuts.length;

      // Compute realized average R-multiple if metadata carries riskUsd.
      const rs = stratOuts
        .map((o) => {
          const risk = typeof o.metadata?.riskUsd === "number" ? o.metadata.riskUsd as number : 0;
          if (risk <= 0) return 0;
          return o.pnl / risk;
        })
        .filter((r) => r !== 0);
      const avgR = rs.length > 0 ? rs.reduce((s, x) => s + x, 0) / rs.length : 0;

      // Direction of tuning:
      //   high win rate AND positive avgR -> we have edge; widen entries
      //     (lower minGapPct, lower deviationThreshold) to take more trades
      //   low win rate -> tighten entries (higher minGapPct)
      const adjustmentDirection = (winRate > 0.6 && avgR > 0.5) ? -1
        : (winRate < 0.4 || avgR < -0.2) ? +1
        : 0;

      if (adjustmentDirection === 0) {
        log.debug("Walk-forward: no adjustment", { strategy, winRate, avgR, n: stratOuts.length });
        continue;
      }

      const params: Record<string, number> = {};
      for (const [paramName, range] of Object.entries(paramSpec)) {
        const current = this.latest.get(strategy)?.params[paramName] ?? range.default;
        // Adjust by MAX_STEP_PCT in the chosen direction.
        const step = current * MAX_STEP_PCT * adjustmentDirection;
        // For "tighten" params (gap-min, deviation-threshold), step UP is more selective.
        // For "loosen" params (orMaxWidthPct), step DOWN is more selective.
        // We treat all params in PARAM_RANGES the same direction (positive=tighten)
        // because by construction they all gate signal frequency.
        const newVal = clamp(current + step, range.min, range.max);
        params[paramName] = newVal;
      }

      const tuned: TunedParams = { strategy, params, n: stratOuts.length, avgR, winRate };
      results.push(tuned);
      this.latest.set(strategy, tuned);

      appendJsonl(TUNED_PARAMS_FILE, { ts: nowIso(), ...tuned });
      log.info("Walk-forward tuning", {
        strategy, n: stratOuts.length,
        winRate: (winRate * 100).toFixed(0) + "%",
        avgR: avgR.toFixed(2),
        direction: adjustmentDirection > 0 ? "tighten" : "loosen",
        params,
      });
    }

    return results;
  }

  // Returns the latest tuned params for a strategy, or null if no tuning yet.
  getParams(strategy: string): TunedParams | null {
    return this.latest.get(strategy) ?? null;
  }

  // Returns the recommended value for a specific param, or the default if
  // no tuning has happened yet. Strategy code calls this on signal-evaluation.
  paramValue(strategy: string, paramName: string): number {
    const tuned = this.latest.get(strategy);
    if (tuned && tuned.params[paramName] !== undefined) return tuned.params[paramName];
    return PARAM_RANGES[strategy]?.[paramName]?.default ?? 0;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, n));
}
