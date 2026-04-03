import { createLogger } from "../core/logger.js";
import type { AppConfig, Opportunity, StrategyType } from "../core/types.js";
import { appendJsonl, readJsonl } from "../utils/persistence.js";
import { isoDate } from "../utils/time.js";

const log = createLogger("self-tuner");

const OUTCOMES_FILE = "data/outcomes.jsonl";
const TUNING_FILE = "data/tuning-state.jsonl";

// Minimum trades before we start adjusting
const MIN_TRADES_FOR_TUNING = 10;
// Rolling window for calibration (trades, not time)
const CALIBRATION_WINDOW = 50;
// How much to adjust k per tuning cycle (learning rate)
const K_LEARNING_RATE = 0.05;
// Bounds for k adjustment (multiplier on initial value)
const K_MIN_MULTIPLIER = 0.25;
const K_MAX_MULTIPLIER = 4.0;
// Auto-disable strategy if win rate below this after MIN trades
const STRATEGY_DISABLE_WIN_RATE = 0.3;
// Re-enable check interval
const REENABLE_CHECK_TRADES = 20;

// Spread threshold adjustment
const SPREAD_ADJUST_STEP = 0.5; // percent
const SPREAD_MIN = 1.0;
const SPREAD_MAX = 20.0;
// If >70% of trades are winners, threshold might be too tight (missing opportunities)
const SPREAD_LOOSEN_WIN_RATE = 0.7;
// If <40% of trades are winners, threshold is too loose
const SPREAD_TIGHTEN_WIN_RATE = 0.4;

export interface OutcomeRecord {
  readonly ts: string;
  readonly opportunityId: string;
  readonly strategy: StrategyType;
  readonly predictedProbability: number;
  readonly marketProbability: number;
  readonly predictedEdge: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly pnl: number;
  readonly holdTimeMs: number;
  readonly slippage: number; // expected fill vs actual fill
  readonly won: boolean;
}

interface StrategyStats {
  trades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  avgSlippage: number;
  enabled: boolean;
  disabledAt: number | null;
}

interface TuningState {
  kMultiplier: number;
  spreadThreshold: number;
  strategies: Record<string, StrategyStats>;
  lastTuneTimestamp: number;
  totalOutcomes: number;
}

export class SelfTuner {
  private outcomes: OutcomeRecord[] = [];
  private state: TuningState;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.state = this.loadState();
    this.outcomes = this.loadOutcomes();
    log.info("Self-tuner initialized", {
      kMultiplier: this.state.kMultiplier.toFixed(3),
      spreadThreshold: this.state.spreadThreshold.toFixed(1),
      outcomes: this.outcomes.length,
    });
  }

  // Called when a position closes. Records the outcome and triggers tuning.
  recordOutcome(
    opportunity: Opportunity,
    entryPrice: number,
    exitPrice: number,
    pnl: number,
    holdTimeMs: number,
  ): void {
    const predicted = typeof opportunity.metadata.trueProbability === "number"
      ? opportunity.metadata.trueProbability : null;
    const market = typeof opportunity.metadata.marketProbability === "number"
      ? opportunity.metadata.marketProbability : null;

    if (predicted === null || market === null) {
      log.warn("Outcome missing probability metadata, recording without calibration data", {
        opportunityId: opportunity.id,
        strategy: opportunity.strategy,
      });
    }
    const slippage = Math.abs(entryPrice - opportunity.params.price);

    const record: OutcomeRecord = {
      ts: new Date().toISOString(),
      opportunityId: opportunity.id,
      strategy: opportunity.strategy,
      predictedProbability: predicted ?? -1, // -1 = unknown, excluded from k-tuning
      marketProbability: market ?? -1,
      predictedEdge: opportunity.expectedSpread,
      entryPrice,
      exitPrice,
      pnl,
      holdTimeMs,
      slippage,
      won: pnl > 0,
    };

    this.outcomes.push(record);
    appendJsonl(OUTCOMES_FILE, record);

    this.state.totalOutcomes++;

    // Update strategy stats
    this.updateStrategyStats(record);

    // Run tuning if enough data
    if (this.state.totalOutcomes >= MIN_TRADES_FOR_TUNING) {
      this.tune();
    }
  }

  // Record a shadow outcome (from opportunity tracking, no real trade)
  // Used for model calibration without risking money
  recordShadowOutcome(
    strategy: StrategyType,
    predictedProbability: number,
    marketProbability: number,
    predictedEdge: number,
    wouldHaveWon: boolean,
  ): void {
    // Create a synthetic outcome record for calibration only
    const record: OutcomeRecord = {
      ts: new Date().toISOString(),
      opportunityId: `shadow-${Date.now()}`,
      strategy,
      predictedProbability,
      marketProbability,
      predictedEdge,
      entryPrice: marketProbability,
      exitPrice: wouldHaveWon ? 1.0 : 0.0,
      pnl: wouldHaveWon ? (1.0 - marketProbability) * 50 : -marketProbability * 50,
      holdTimeMs: 0,
      slippage: 0,
      won: wouldHaveWon,
    };

    this.outcomes.push(record);
    this.state.totalOutcomes++;

    // Shadow outcomes count for tuning but NOT for strategy enable/disable
    // (don't disable a strategy based on hypothetical outcomes)

    if (this.state.totalOutcomes >= MIN_TRADES_FOR_TUNING) {
      this.tune();
    }
  }

  // Get the current k multiplier (applied to the base k in temporal-arb)
  getKMultiplier(): number {
    return this.state.kMultiplier;
  }

  // Get the current adaptive spread threshold
  getSpreadThreshold(): number {
    return this.state.spreadThreshold;
  }

  // Check if a strategy is currently enabled
  isStrategyEnabled(strategy: StrategyType): boolean {
    const stats = this.state.strategies[strategy];
    if (!stats) return true; // Unknown strategy = enabled by default
    return stats.enabled;
  }

  // Get human-readable performance summary
  getSummary(): string {
    const recent = this.outcomes.slice(-CALIBRATION_WINDOW);
    const wins = recent.filter((o) => o.won).length;
    const total = recent.length;
    const avgSlippage = total > 0
      ? recent.reduce((s, o) => s + o.slippage, 0) / total
      : 0;
    const avgPnl = total > 0
      ? recent.reduce((s, o) => s + o.pnl, 0) / total
      : 0;

    const stratLines = Object.entries(this.state.strategies)
      .map(([name, s]) => {
        const wr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(0) : "n/a";
        return `  ${name}: ${s.trades} trades, ${wr}% win rate, $${s.totalPnl.toFixed(2)} P&L, ${s.enabled ? "enabled" : "DISABLED"}`;
      })
      .join("\n");

    return [
      `Self-Tuner Status (${total} recent trades):`,
      `  k multiplier: ${this.state.kMultiplier.toFixed(3)}`,
      `  Spread threshold: ${this.state.spreadThreshold.toFixed(1)}%`,
      `  Recent win rate: ${total > 0 ? ((wins / total) * 100).toFixed(0) : "n/a"}%`,
      `  Avg P&L per trade: $${avgPnl.toFixed(4)}`,
      `  Avg slippage: $${avgSlippage.toFixed(4)}`,
      `Strategy breakdown:`,
      stratLines || "  (no strategy data)",
    ].join("\n");
  }

  private updateStrategyStats(record: OutcomeRecord): void {
    if (!this.state.strategies[record.strategy]) {
      this.state.strategies[record.strategy] = {
        trades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        avgSlippage: 0,
        enabled: true,
        disabledAt: null,
      };
    }

    const stats = this.state.strategies[record.strategy];
    stats.trades++;
    if (record.won) stats.wins++;
    else stats.losses++;
    stats.totalPnl += record.pnl;
    stats.avgSlippage = (stats.avgSlippage * (stats.trades - 1) + record.slippage) / stats.trades;
  }

  private tune(): void {
    const recent = this.outcomes.slice(-CALIBRATION_WINDOW);
    if (recent.length < MIN_TRADES_FOR_TUNING) return;

    // 1. Calibrate k multiplier based on prediction accuracy
    this.tuneKParameter(recent);

    // 2. Adjust spread threshold based on win rate
    this.tuneSpreadThreshold(recent);

    // 3. Check strategy health
    this.checkStrategies();

    // 4. Persist state
    this.state.lastTuneTimestamp = Date.now();
    this.saveState();

    log.info("Self-tuning complete", {
      kMultiplier: this.state.kMultiplier.toFixed(3),
      spreadThreshold: this.state.spreadThreshold.toFixed(1),
      recentWinRate: ((recent.filter((o) => o.won).length / recent.length) * 100).toFixed(0),
    });
  }

  private tuneKParameter(recent: OutcomeRecord[]): void {
    // Only use records with valid probability metadata for calibration
    const calibratable = recent.filter((o) => o.predictedProbability >= 0 && o.marketProbability >= 0);
    const highEdge = calibratable.filter((o) => o.predictedEdge >= 10);
    const lowEdge = calibratable.filter((o) => o.predictedEdge < 10 && o.predictedEdge >= 5);

    const highWinRate = highEdge.length > 0
      ? highEdge.filter((o) => o.won).length / highEdge.length
      : 0.5;
    const lowWinRate = lowEdge.length > 0
      ? lowEdge.filter((o) => o.won).length / lowEdge.length
      : 0.5;

    // If high-edge trades don't win significantly more than low-edge,
    // the model is overconfident => increase k (flatter curve)
    // If high-edge trades win much more, model is underconfident => decrease k (steeper)
    const edgeDiff = highWinRate - lowWinRate;

    // Require minimum 8 trades per bucket to reduce variance and prevent oscillation
    if (highEdge.length >= 8 && lowEdge.length >= 8) {
      if (edgeDiff < 0.05) {
        // Model overconfident: high edge doesn't predict better outcomes
        this.state.kMultiplier = Math.min(
          this.state.kMultiplier * (1 + K_LEARNING_RATE),
          K_MAX_MULTIPLIER,
        );
        log.info("k adjusted up (overconfident)", {
          kMultiplier: this.state.kMultiplier.toFixed(3),
          highWinRate: highWinRate.toFixed(2),
          lowWinRate: lowWinRate.toFixed(2),
        });
      } else if (edgeDiff > 0.2) {
        // Model underconfident: high edge is very predictive
        this.state.kMultiplier = Math.max(
          this.state.kMultiplier * (1 - K_LEARNING_RATE),
          K_MIN_MULTIPLIER,
        );
        log.info("k adjusted down (underconfident)", {
          kMultiplier: this.state.kMultiplier.toFixed(3),
          highWinRate: highWinRate.toFixed(2),
          lowWinRate: lowWinRate.toFixed(2),
        });
      }
    }
  }

  private tuneSpreadThreshold(recent: OutcomeRecord[]): void {
    const winRate = recent.filter((o) => o.won).length / recent.length;

    if (winRate > SPREAD_LOOSEN_WIN_RATE && recent.length >= MIN_TRADES_FOR_TUNING) {
      // Winning too much = threshold too tight, missing opportunities
      const newThreshold = Math.max(this.state.spreadThreshold - SPREAD_ADJUST_STEP, SPREAD_MIN);
      if (newThreshold !== this.state.spreadThreshold) {
        log.info("Spread threshold lowered (high win rate)", {
          old: this.state.spreadThreshold,
          new: newThreshold,
          winRate: (winRate * 100).toFixed(0),
        });
        this.state.spreadThreshold = newThreshold;
      }
    } else if (winRate < SPREAD_TIGHTEN_WIN_RATE && recent.length >= MIN_TRADES_FOR_TUNING) {
      // Losing too much = threshold too loose
      const newThreshold = Math.min(this.state.spreadThreshold + SPREAD_ADJUST_STEP, SPREAD_MAX);
      if (newThreshold !== this.state.spreadThreshold) {
        log.info("Spread threshold raised (low win rate)", {
          old: this.state.spreadThreshold,
          new: newThreshold,
          winRate: (winRate * 100).toFixed(0),
        });
        this.state.spreadThreshold = newThreshold;
      }
    }
  }

  private checkStrategies(): void {
    for (const [name, stats] of Object.entries(this.state.strategies)) {
      if (stats.trades < MIN_TRADES_FOR_TUNING) continue;

      const winRate = stats.wins / stats.trades;

      // Disable underperforming strategies
      if (stats.enabled && winRate < STRATEGY_DISABLE_WIN_RATE) {
        stats.enabled = false;
        stats.disabledAt = Date.now();
        log.warn("Strategy auto-disabled due to poor performance", {
          strategy: name,
          winRate: (winRate * 100).toFixed(0),
          trades: stats.trades,
          pnl: stats.totalPnl.toFixed(2),
        });
      }

      // Re-enable check: if disabled and enough new trades have passed, re-evaluate
      if (!stats.enabled && stats.disabledAt) {
        const tradesSinceDisable = this.outcomes
          .filter((o) => o.strategy === name && new Date(o.ts).getTime() > stats.disabledAt!)
          .length;

        if (tradesSinceDisable >= REENABLE_CHECK_TRADES) {
          const recentForStrategy = this.outcomes
            .filter((o) => o.strategy === name)
            .slice(-REENABLE_CHECK_TRADES);
          const recentWinRate = recentForStrategy.filter((o) => o.won).length / recentForStrategy.length;

          if (recentWinRate >= 0.5) {
            stats.enabled = true;
            stats.disabledAt = null;
            log.info("Strategy re-enabled after recovery", {
              strategy: name,
              recentWinRate: (recentWinRate * 100).toFixed(0),
            });
          }
        }
      }
    }
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
        log.info("Loaded tuning state", {
          kMultiplier: latest.kMultiplier,
          spreadThreshold: latest.spreadThreshold,
        });
        return latest;
      }
    } catch {
      // Use defaults
    }

    return {
      kMultiplier: 1.0,
      spreadThreshold: this.config.minSpreadThreshold,
      strategies: {},
      lastTuneTimestamp: 0,
      totalOutcomes: 0,
    };
  }

  private saveState(): void {
    appendJsonl(TUNING_FILE, this.state);
  }
}
