// Multi-timeframe direction validator.
//
// For an intended LONG/SHORT trade on a symbol, this checks whether the
// direction is supported on multiple timeframes simultaneously. Confluence
// across timeframes is one of the most reliable directional filters in
// retail technical analysis.
//
// Checks:
//   1-min:   last 10 closes trending in intended direction
//   5-min:   last 10 closes trending in intended direction
//   15-min:  last 6 closes trending in intended direction
//   60-min:  last 5 closes trending in intended direction
//
// "Trending" = linear-regression slope of close prices is positive (LONG)
// or negative (SHORT) over the lookback, AND the latest close is on the
// same side of the regression as the slope.
//
// Returns a CheckResult that votes +1 if all timeframes agree, scales
// down by partial agreement. Confidence rises with the number of agreeing
// timeframes.

import { createLogger } from "../core/logger.js";
import type { Bar } from "../core/types.js";
import type { CheckResult } from "./confluence.js";

const log = createLogger("multi-tf");

export interface MultiTfBarsProvider {
  // Provide N most recent bars at the given resolution for the symbol.
  // Bars must be sorted ascending by timestamp.
  getBars(symbol: string, resolution: "1m" | "5m" | "15m" | "60m", n: number): readonly Bar[];
}

export class MultiTimeframeValidator {
  constructor(private readonly bars: MultiTfBarsProvider) {}

  evaluate(symbol: string, direction: "LONG" | "SHORT"): CheckResult {
    const timeframes: { res: "1m" | "5m" | "15m" | "60m"; n: number; weight: number }[] = [
      { res: "1m", n: 10, weight: 0.5 },
      { res: "5m", n: 10, weight: 1.0 },
      { res: "15m", n: 6, weight: 1.0 },
      { res: "60m", n: 5, weight: 0.75 },
    ];

    let totalWeight = 0;
    let agreeWeight = 0;
    const detail: string[] = [];

    for (const tf of timeframes) {
      const bars = this.bars.getBars(symbol, tf.res, tf.n);
      if (bars.length < tf.n) {
        detail.push(`${tf.res}:no-data`);
        continue;
      }
      const slope = linearSlope(bars.map((b) => b.close));
      const lastClose = bars[bars.length - 1].close;
      const meanClose = bars.reduce((s, b) => s + b.close, 0) / bars.length;
      const supports = direction === "LONG"
        ? slope > 0 && lastClose >= meanClose
        : slope < 0 && lastClose <= meanClose;

      totalWeight += tf.weight;
      if (supports) {
        agreeWeight += tf.weight;
        detail.push(`${tf.res}:+`);
      } else {
        detail.push(`${tf.res}:-`);
      }
    }

    if (totalWeight === 0) {
      return {
        name: "multi-tf",
        vote: 0,
        confidence: 0,
        weight: 1.0,
        detail: "no data on any timeframe",
      };
    }

    const agreeRatio = agreeWeight / totalWeight;
    // Vote scales from -1 (none agree) to +1 (all agree).
    const vote = (agreeRatio * 2) - 1;
    const confidence = totalWeight > 2 ? 0.85 : 0.6;

    log.debug("Multi-TF check", { symbol, direction, agreeRatio, detail: detail.join(",") });

    return {
      name: "multi-tf",
      vote,
      confidence,
      weight: 1.5,            // multi-TF carries above-average weight
      detail: detail.join(","),
    };
  }
}

// Linear regression slope of values vs index.
function linearSlope(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const sumX = (n * (n - 1)) / 2;
  const sumY = values.reduce((s, v) => s + v, 0);
  const sumXY = values.reduce((s, v, i) => s + i * v, 0);
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}
