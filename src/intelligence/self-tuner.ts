// Self-tuner: tracks outcomes by strategy and setup bucket, computes
// rolling win rates and R-multiple statistics, and exposes adjusted
// thresholds within bounded ranges.
//
// What it tunes:
//   - LLM score floor (only trade candidates whose score >= this floor)
//   - Per-strategy size multiplier (down-weight strategies in a slump)
//   - Engine-A gap-size bucket adjustments (which gap ranges are working)
//
// Not configured to tune entry parameters of the strategies themselves
// (OR window, R:R target, etc.). Those are hardcoded based on research;
// the tuner moves position size and selectivity, which are safer to
// adjust live.

import { createLogger } from "../core/logger.js";
import { appendJsonl, readJsonl } from "../utils/persistence.js";
import { nowIso } from "../utils/time.js";
import type { StrategyType } from "../core/types.js";

const log = createLogger("self-tuner");

const OUTCOMES_FILE = "data/outcomes.jsonl";
const TUNING_FILE = "data/tuning-state.jsonl";
const PROPOSALS_FILE = "data/tuner-proposals.jsonl";

// Council ops review required at least 30 closed trades in a bucket
// before any tuner adjustment can take effect — fewer trades than that
// can't statistically distinguish edge from noise. Bumped from 10.
const MIN_TRADES_FOR_TUNING = 30;
const ROLLING_WINDOW = 50;

// Drift detection thresholds.
const MIN_DRIFT_LIFETIME_N = 15;        // need this much history before drift is evaluable
const MIN_DRIFT_RECENT_N = 8;           // minimum recent window
const DRIFT_RECENT_WINDOW = 20;         // size of recent trade window for drift compare
const DRIFT_Z_THRESHOLD = 1.5;          // |z| > this triggers drift status change
const LLM_SCORE_MIN = 0;
const LLM_SCORE_MAX = 10;
const LLM_SCORE_STEP = 0.5;
// Council ops review: hard bounds on position size multiplier so a
// lucky streak can't have the tuner ratchet size into a blow-up. Floor
// raised from 0.25 to 0.5 (half-size, not quarter).
const SIZE_MULT_MIN = 0.5;
const SIZE_MULT_MAX = 1.5;
const SIZE_MULT_STEP = 0.05;

// Strategy is auto-disabled after MIN_TRADES_FOR_TUNING if win-rate is below
// this. Re-enabled later if it recovers.
const STRATEGY_DISABLE_WIN_RATE = 0.3;
const REENABLE_CHECK_TRADES = 20;
const REENABLE_WIN_RATE = 0.5;

interface OutcomeRecord {
  readonly ts: string;
  readonly key: string;
  readonly strategy: StrategyType;
  readonly side: "LONG" | "SHORT";
  readonly qty: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly fees: number;
  readonly pnl: number;
  readonly holdMs: number;
  readonly metadata?: Record<string, unknown>;
}

interface StrategyStats {
  trades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  totalR: number;
  enabled: boolean;
  disabledAt: number | null;
  sizeMultiplier: number;
  driftStatus: "normal" | "drift_down" | "drift_up";
  lastDriftCheck: number;
}

export interface DriftReport {
  readonly strategy: string;
  readonly status: "normal" | "drift_down" | "drift_up";
  readonly z: number;
  readonly recentWinRate: number;
  readonly lifetimeWinRate: number;
  readonly recentN: number;
  readonly lifetimeN: number;
}

interface TuningState {
  ts: string;
  llmScoreFloor: number;
  totalOutcomes: number;
  strategies: Record<string, StrategyStats>;
}

// Hook called after every outcome so external components (ConvictionSizer,
// WalkForwardOptimizer) can recompute their adaptive parameters.
export type OutcomeListener = (outcomes: readonly OutcomeRecord[]) => void;

// Walk-forward optimizer integration. SelfTuner triggers it every N tunes.
import { WalkForwardOptimizer } from "./walk-forward.js";

export class SelfTuner {
  private state: TuningState;
  private outcomes: OutcomeRecord[];
  private listeners: OutcomeListener[] = [];
  private walkForward = new WalkForwardOptimizer();

  getWalkForward(): WalkForwardOptimizer { return this.walkForward; }

  // Subscribe to outcome updates. Called on every recordOutcome().
  onOutcome(fn: OutcomeListener): void { this.listeners.push(fn); }

  // When false (the default for the first 60 days live per the council ops
  // review), the tuner writes parameter-change proposals to
  // data/tuner-proposals.jsonl instead of mutating live state. The bot
  // continues to use baseline parameters until the operator reviews and
  // applies a proposal. Flip via SelfTuner({ autoApply: true }) after live
  // tuning is justified.
  private readonly autoApply: boolean;

  constructor(opts: { autoApply?: boolean } = {}) {
    this.autoApply = opts.autoApply ?? false;
    this.outcomes = this.loadOutcomes();
    this.state = this.loadState();
    log.info("Self-tuner initialized", {
      llmScoreFloor: this.state.llmScoreFloor,
      outcomes: this.outcomes.length,
      autoApply: this.autoApply,
    });
  }

  // Record a parameter change without mutating live state. Used when the
  // tuner is in proposal-only mode. Operator can review proposals in
  // data/tuner-proposals.jsonl and apply manually.
  private proposeChange(field: string, fromValue: number | boolean, toValue: number | boolean, justification: Record<string, unknown>): void {
    const entry = {
      ts: nowIso(),
      field,
      fromValue,
      toValue,
      justification,
      applied: false,
    };
    appendJsonl(PROPOSALS_FILE, entry);
    log.info("Tuner proposal recorded (proposal-only mode)", { field, fromValue, toValue });
  }

  // Read after every trade outcome. Strategies should call this before
  // trade-time and use the returned threshold.
  getLlmScoreFloor(): number {
    return this.state.llmScoreFloor;
  }

  getSizeMultiplier(strategy: StrategyType): number {
    return this.state.strategies[strategy]?.sizeMultiplier ?? 1.0;
  }

  isEnabled(strategy: StrategyType): boolean {
    const s = this.state.strategies[strategy];
    return s ? s.enabled : true;
  }

  // Record one closed-position outcome and re-tune.
  recordOutcome(record: OutcomeRecord): void {
    this.outcomes.push(record);
    this.state.totalOutcomes++;
    this.updateStrategyStats(record);
    if (this.state.totalOutcomes >= MIN_TRADES_FOR_TUNING) {
      this.tune();
    }
    // Notify external subscribers (e.g. ConvictionSizer adapts its tiers).
    for (const fn of this.listeners) {
      try { fn(this.outcomes); }
      catch (err) { log.warn("Outcome listener threw", { error: err instanceof Error ? err.message : String(err) }); }
    }
  }

  summary(): string {
    const recent = this.outcomes.slice(-ROLLING_WINDOW);
    const wins = recent.filter((o) => o.pnl > 0).length;
    const total = recent.length;
    const avgPnl = total > 0 ? recent.reduce((s, o) => s + o.pnl, 0) / total : 0;

    const stratLines = Object.entries(this.state.strategies)
      .map(([name, s]) => {
        const wr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(0) : "n/a";
        return `  ${name}: ${s.trades} trades, ${wr}% wr, $${s.totalPnl.toFixed(2)}, size ${s.sizeMultiplier.toFixed(2)}x, ${s.enabled ? "enabled" : "DISABLED"}`;
      })
      .join("\n");

    return [
      `Self-Tuner (${total} recent trades):`,
      `  LLM score floor: ${this.state.llmScoreFloor.toFixed(1)}`,
      `  Win rate (recent): ${total > 0 ? ((wins / total) * 100).toFixed(0) : "n/a"}%`,
      `  Avg P&L/trade: $${avgPnl.toFixed(2)}`,
      `Strategies:`,
      stratLines || "  (no data)",
    ].join("\n");
  }

  // Per-strategy drift detection. Compares the rolling-window win rate to
  // the lifetime win rate using a z-score on the binomial proportion.
  // Returns the current drift status for each strategy.
  //
  // Side effect: when drift transitions, the strategy's sizeMultiplier
  // is adjusted defensively (drift_down -> halve, drift_up -> modest +1.2).
  // Strategies need at least MIN_DRIFT_LIFETIME_N total trades and
  // MIN_DRIFT_RECENT_N recent trades before drift is evaluated.
  detectDriftFor(strategy: string): DriftReport | null {
    const stats = this.state.strategies[strategy];
    if (!stats || stats.trades < MIN_DRIFT_LIFETIME_N) return null;
    const recent = this.outcomes
      .filter((o) => o.strategy === strategy)
      .slice(-DRIFT_RECENT_WINDOW);
    if (recent.length < MIN_DRIFT_RECENT_N) return null;

    const recentWins = recent.filter((o) => o.pnl > 0).length;
    const recentN = recent.length;
    const recentWR = recentWins / recentN;
    const lifetimeWR = stats.wins / stats.trades;

    // Standard error of difference between two proportions.
    const pPooled = (stats.wins + recentWins) / (stats.trades + recentN);
    const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / stats.trades + 1 / recentN));
    if (se === 0) return null;
    const z = (recentWR - lifetimeWR) / se;

    let status: DriftReport["status"];
    if (z < -DRIFT_Z_THRESHOLD) status = "drift_down";
    else if (z > DRIFT_Z_THRESHOLD) status = "drift_up";
    else status = "normal";

    return { strategy, status, z, recentWinRate: recentWR, lifetimeWinRate: lifetimeWR, recentN, lifetimeN: stats.trades };
  }

  // Apply drift adjustments. Called from tune() after each outcome.
  // In proposal-only mode (autoApply=false) drift detections still LOG and
  // record a proposal but do not mutate sizeMultiplier.
  private applyDrift(): void {
    for (const [name, stats] of Object.entries(this.state.strategies)) {
      const report = this.detectDriftFor(name);
      if (!report) continue;
      if (report.status === stats.driftStatus) continue;       // no transition

      const prev = stats.driftStatus;
      stats.driftStatus = report.status;
      stats.lastDriftCheck = Date.now();

      if (report.status === "drift_down") {
        const next = clamp(stats.sizeMultiplier * 0.5, SIZE_MULT_MIN, SIZE_MULT_MAX);
        if (this.autoApply) {
          stats.sizeMultiplier = next;
          log.warn("Strategy drift DOWN detected — halving size", {
            strategy: name, z: report.z.toFixed(2),
            recentWR: (report.recentWinRate * 100).toFixed(0) + "%",
            lifetimeWR: (report.lifetimeWinRate * 100).toFixed(0) + "%",
            newSizeMul: stats.sizeMultiplier.toFixed(2),
          });
        } else {
          this.proposeChange(`strategies.${name}.sizeMultiplier`, stats.sizeMultiplier, next, { reason: "drift_down", z: report.z.toFixed(2), recentWR: report.recentWinRate.toFixed(3), lifetimeWR: report.lifetimeWinRate.toFixed(3) });
        }
      } else if (report.status === "drift_up") {
        const next = clamp(stats.sizeMultiplier * 1.2, SIZE_MULT_MIN, SIZE_MULT_MAX);
        if (this.autoApply) {
          stats.sizeMultiplier = next;
          log.info("Strategy drift UP detected — modest size bump", {
            strategy: name, z: report.z.toFixed(2),
            recentWR: (report.recentWinRate * 100).toFixed(0) + "%",
            lifetimeWR: (report.lifetimeWinRate * 100).toFixed(0) + "%",
            newSizeMul: stats.sizeMultiplier.toFixed(2),
          });
        } else {
          this.proposeChange(`strategies.${name}.sizeMultiplier`, stats.sizeMultiplier, next, { reason: "drift_up", z: report.z.toFixed(2), recentWR: report.recentWinRate.toFixed(3), lifetimeWR: report.lifetimeWinRate.toFixed(3) });
        }
      } else if (prev !== "normal") {
        log.info("Strategy drift cleared", { strategy: name, fromStatus: prev });
      }
    }
  }

  // ----- Internals -----

  private updateStrategyStats(record: OutcomeRecord): void {
    let stats = this.state.strategies[record.strategy];
    if (!stats) {
      stats = {
        trades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        totalR: 0,
        enabled: true,
        disabledAt: null,
        sizeMultiplier: 1.0,
        driftStatus: "normal",
        lastDriftCheck: 0,
      };
      this.state.strategies[record.strategy] = stats;
    }
    stats.trades++;
    if (record.pnl > 0) stats.wins++;
    else stats.losses++;
    stats.totalPnl += record.pnl;
    // Approximate R-multiple if metadata carries riskUsd.
    const risk = typeof record.metadata?.riskUsd === "number" ? (record.metadata.riskUsd as number) : 0;
    if (risk > 0) stats.totalR += record.pnl / risk;
  }

  private tune(): void {
    const recent = this.outcomes.slice(-ROLLING_WINDOW);
    const winRate = recent.filter((o) => o.pnl > 0).length / recent.length;

    // LLM score floor moves with overall win rate. In proposal-only mode
    // (autoApply=false, the default for first 60 days live), the change
    // is recorded to data/tuner-proposals.jsonl and live state stays at
    // baseline. Operator promotes proposals manually after review.
    if (winRate > 0.65) {
      const next = clamp(this.state.llmScoreFloor - LLM_SCORE_STEP, LLM_SCORE_MIN, LLM_SCORE_MAX);
      if (next !== this.state.llmScoreFloor) {
        if (this.autoApply) this.state.llmScoreFloor = next;
        else this.proposeChange("llmScoreFloor", this.state.llmScoreFloor, next, { winRate: winRate.toFixed(3), windowSize: recent.length, direction: "lower (less selective)" });
      }
    } else if (winRate < 0.4) {
      const next = clamp(this.state.llmScoreFloor + LLM_SCORE_STEP, LLM_SCORE_MIN, LLM_SCORE_MAX);
      if (next !== this.state.llmScoreFloor) {
        if (this.autoApply) this.state.llmScoreFloor = next;
        else this.proposeChange("llmScoreFloor", this.state.llmScoreFloor, next, { winRate: winRate.toFixed(3), windowSize: recent.length, direction: "raise (more selective)" });
      }
    }

    // Per-strategy size multiplier and enable/disable.
    for (const [name, stats] of Object.entries(this.state.strategies)) {
      if (stats.trades < MIN_TRADES_FOR_TUNING) continue;
      const strategyWinRate = stats.wins / stats.trades;

      if (stats.enabled && strategyWinRate < STRATEGY_DISABLE_WIN_RATE) {
        if (this.autoApply) {
          stats.enabled = false;
          stats.disabledAt = Date.now();
          log.warn("Strategy auto-disabled", {
            strategy: name,
            winRate: (strategyWinRate * 100).toFixed(0),
            trades: stats.trades,
          });
        } else {
          this.proposeChange(`strategies.${name}.enabled`, true, false, { winRate: strategyWinRate.toFixed(3), trades: stats.trades, reason: "win-rate below disable threshold" });
        }
      } else if (!stats.enabled && stats.disabledAt) {
        const tradesSince = this.outcomes
          .filter((o) => o.strategy === name && new Date(o.ts).getTime() > stats.disabledAt!).length;
        if (tradesSince >= REENABLE_CHECK_TRADES) {
          const sub = this.outcomes
            .filter((o) => o.strategy === name)
            .slice(-REENABLE_CHECK_TRADES);
          const subWr = sub.filter((o) => o.pnl > 0).length / sub.length;
          if (subWr >= REENABLE_WIN_RATE) {
            if (this.autoApply) {
              stats.enabled = true;
              stats.disabledAt = null;
              log.info("Strategy re-enabled", { strategy: name, recentWinRate: (subWr * 100).toFixed(0) });
            } else {
              this.proposeChange(`strategies.${name}.enabled`, false, true, { recentWinRate: subWr.toFixed(3), tradesSince, reason: "recovered win-rate" });
            }
          }
        }
      }

      // Move size multiplier gradually based on per-strategy win rate.
      if (strategyWinRate > 0.6) {
        const next = clamp(stats.sizeMultiplier + SIZE_MULT_STEP, SIZE_MULT_MIN, SIZE_MULT_MAX);
        if (next !== stats.sizeMultiplier) {
          if (this.autoApply) stats.sizeMultiplier = next;
          else this.proposeChange(`strategies.${name}.sizeMultiplier`, stats.sizeMultiplier, next, { winRate: strategyWinRate.toFixed(3), trades: stats.trades, direction: "increase" });
        }
      } else if (strategyWinRate < 0.4) {
        const next = clamp(stats.sizeMultiplier - SIZE_MULT_STEP, SIZE_MULT_MIN, SIZE_MULT_MAX);
        if (next !== stats.sizeMultiplier) {
          if (this.autoApply) stats.sizeMultiplier = next;
          else this.proposeChange(`strategies.${name}.sizeMultiplier`, stats.sizeMultiplier, next, { winRate: strategyWinRate.toFixed(3), trades: stats.trades, direction: "decrease" });
        }
      }
    }

    // Drift detection after each tune pass.
    this.applyDrift();
    // Walk-forward parameter optimization on a less-frequent cadence
    // (every 10 outcomes once we cross the minimum).
    if (this.state.totalOutcomes % 10 === 0) {
      this.walkForward.optimize();
    }

    this.state.ts = nowIso();
    appendJsonl(TUNING_FILE, this.state);
    log.info("Tuning complete", {
      llmScoreFloor: this.state.llmScoreFloor.toFixed(1),
      strategies: Object.keys(this.state.strategies).length,
    });
  }

  private loadOutcomes(): OutcomeRecord[] {
    try {
      return readJsonl<OutcomeRecord>(OUTCOMES_FILE);
    } catch {
      return [];
    }
  }

  private loadState(): TuningState {
    try {
      const records = readJsonl<TuningState>(TUNING_FILE);
      if (records.length > 0) {
        const latest = records[records.length - 1];
        return latest;
      }
    } catch { /* fall through */ }

    return {
      ts: nowIso(),
      llmScoreFloor: 0,                // start permissive
      totalOutcomes: 0,
      strategies: {},
    };
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
