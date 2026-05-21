// Kelly-bounded position sizer.
//
// The Kelly criterion: f* = (p * (b + 1) - 1) / b
//   where p = win probability, b = avg_win / avg_loss
//
// Pure Kelly maximizes long-run geometric growth but has 50% drawdown
// volatility. We use FRACTIONAL Kelly (1/4 to 1/2) to balance growth vs
// drawdown. The fraction is configurable per risk appetite.
//
// On every closed trade, we update the rolling estimates of win rate and
// win/loss ratio from data/outcomes.jsonl, then compute the suggested
// position size as a percent of bankroll. This replaces fixed 1% sizing
// once we have enough closed trades to estimate Kelly reliably.

import { createLogger } from "../core/logger.js";
import { readJsonl } from "../utils/persistence.js";

const log = createLogger("kelly-sizer");

const OUTCOMES_FILE = "data/outcomes.jsonl";

const MIN_TRADES_FOR_KELLY = 20;          // need history to estimate
const MAX_KELLY_FRACTION = 0.10;          // hard cap at 10% per trade
const MIN_KELLY_FRACTION = 0.005;         // floor at 0.5% per trade

export interface KellyParams {
  // Fraction of full Kelly to use. 0.25 = quarter-Kelly (conservative),
  // 0.5 = half-Kelly (moderate), 1.0 = full Kelly (aggressive).
  readonly fraction: number;
  // Per-strategy override. If a strategy has different win-rate dynamics,
  // compute Kelly separately for it.
  readonly perStrategy?: boolean;
}

interface OutcomeRow {
  readonly strategy: string;
  readonly pnl: number;
}

export interface KellySuggestion {
  readonly recommendedRiskPct: number;     // % of bankroll to risk per trade
  readonly kellyFullPct: number;            // raw Kelly fraction (uncapped)
  readonly winRate: number;
  readonly avgWinLossRatio: number;
  readonly sampleSize: number;
  readonly source: "kelly" | "default";    // "default" when too few trades
}

export class KellySizer {
  constructor(private readonly params: KellyParams) {}

  suggest(defaultRiskPct: number, strategy?: string): KellySuggestion {
    let outcomes: OutcomeRow[];
    try { outcomes = readJsonl<OutcomeRow>(OUTCOMES_FILE); }
    catch { outcomes = []; }

    if (this.params.perStrategy && strategy) {
      outcomes = outcomes.filter((o) => o.strategy === strategy);
    }

    if (outcomes.length < MIN_TRADES_FOR_KELLY) {
      return {
        recommendedRiskPct: defaultRiskPct,
        kellyFullPct: 0,
        winRate: 0,
        avgWinLossRatio: 0,
        sampleSize: outcomes.length,
        source: "default",
      };
    }

    const wins = outcomes.filter((o) => o.pnl > 0);
    const losses = outcomes.filter((o) => o.pnl < 0);
    if (wins.length === 0 || losses.length === 0) {
      return {
        recommendedRiskPct: defaultRiskPct,
        kellyFullPct: 0,
        winRate: wins.length / outcomes.length,
        avgWinLossRatio: 0,
        sampleSize: outcomes.length,
        source: "default",
      };
    }

    const p = wins.length / outcomes.length;
    const avgWin = wins.reduce((s, o) => s + o.pnl, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, o) => s + o.pnl, 0) / losses.length);
    const b = avgWin / avgLoss;
    const kellyFull = (p * (b + 1) - 1) / b;

    if (kellyFull <= 0) {
      // Negative-edge data — fall back to default risk so the bot keeps
      // trading at minimum size while the self-tuner figures out whether
      // to disable the strategy entirely.
      return {
        recommendedRiskPct: defaultRiskPct,
        kellyFullPct: kellyFull,
        winRate: p,
        avgWinLossRatio: b,
        sampleSize: outcomes.length,
        source: "default",
      };
    }

    const scaled = kellyFull * this.params.fraction;
    const capped = Math.max(MIN_KELLY_FRACTION, Math.min(MAX_KELLY_FRACTION, scaled));
    const recommendedRiskPct = capped * 100;

    log.info("Kelly suggestion", {
      strategy: strategy ?? "all",
      n: outcomes.length,
      winRate: (p * 100).toFixed(1) + "%",
      avgWinLoss: b.toFixed(2),
      kellyFull: (kellyFull * 100).toFixed(1) + "%",
      scaledKelly: (scaled * 100).toFixed(1) + "%",
      recommendedRiskPct: recommendedRiskPct.toFixed(2) + "%",
    });

    return {
      recommendedRiskPct,
      kellyFullPct: kellyFull * 100,
      winRate: p,
      avgWinLossRatio: b,
      sampleSize: outcomes.length,
      source: "kelly",
    };
  }
}
