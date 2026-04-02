import { createLogger } from "../core/logger.js";
import type { PositionTracker } from "../execution/position-tracker.js";
import type { TradeRecord } from "../core/types.js";
import { readJsonl } from "../utils/persistence.js";

const log = createLogger("pnl-tracker");

export class PnlTracker {
  private readonly positions: PositionTracker;

  // Loaded from disk on startup (historical totals)
  private historicalPnl = 0;
  private historicalFees = 0;
  private historicalTradeCount = 0;
  private historicalWins = 0;
  private historicalLosses = 0;

  // Session-only counters (this run only, not yet on disk at startup)
  private sessionPnl = 0;
  private sessionFees = 0;
  private sessionTradeCount = 0;
  private sessionWins = 0;
  private sessionLosses = 0;

  // Track how many trades were on disk at startup to avoid double-counting
  private readonly diskTradeCount: number;

  constructor(positions: PositionTracker) {
    this.positions = positions;
    this.diskTradeCount = this.loadHistory();
  }

  // Called when a position is closed during this session
  recordTrade(pnl: number, fees: number): void {
    this.sessionPnl += pnl;
    this.sessionFees += fees;
    this.sessionTradeCount++;
    if (pnl > 0) this.sessionWins++;
    else if (pnl < 0) this.sessionLosses++;
  }

  getRealizedPnl(): number {
    return this.historicalPnl + this.sessionPnl;
  }

  getUnrealizedPnl(): number {
    return this.positions.getTotalUnrealizedPnl();
  }

  getTotalPnl(): number {
    return this.getRealizedPnl() + this.getUnrealizedPnl();
  }

  getTotalFees(): number {
    return this.historicalFees + this.sessionFees;
  }

  getNetPnl(): number {
    return this.getTotalPnl() - this.getTotalFees();
  }

  getTradeCount(): number {
    return this.historicalTradeCount + this.sessionTradeCount;
  }

  getWinCount(): number {
    return this.historicalWins + this.sessionWins;
  }

  getLossCount(): number {
    return this.historicalLosses + this.sessionLosses;
  }

  getWinRate(): number {
    const total = this.getTradeCount();
    if (total === 0) return 0;
    return this.getWinCount() / total;
  }

  getSummary(): string {
    return [
      `Realized P&L: $${this.getRealizedPnl().toFixed(2)}`,
      `Unrealized P&L: $${this.getUnrealizedPnl().toFixed(2)}`,
      `Net P&L: $${this.getNetPnl().toFixed(2)}`,
      `Total Fees: $${this.getTotalFees().toFixed(2)}`,
      `Trades: ${this.getTradeCount()} (${this.getWinCount()}W/${this.getLossCount()}L)`,
      `Win Rate: ${(this.getWinRate() * 100).toFixed(1)}%`,
      `Open Positions: ${this.positions.getOpenPositionCount()}`,
      `Total Exposure: $${this.positions.getTotalExposure().toFixed(2)}`,
    ].join("\n");
  }

  // Load historical trades from disk. Returns the number of records loaded.
  private loadHistory(): number {
    try {
      const trades = readJsonl<TradeRecord>("data/trades.jsonl");
      for (const t of trades) {
        if (t.pnl !== null && t.pnl !== undefined) {
          this.historicalPnl += t.pnl;
          this.historicalTradeCount++;
          if (t.pnl > 0) this.historicalWins++;
          else if (t.pnl < 0) this.historicalLosses++;
        }
        if (typeof t.fees === "number") {
          this.historicalFees += t.fees;
        }
      }
      if (trades.length > 0) {
        log.info("Loaded trade history", {
          records: trades.length,
          closedTrades: this.historicalTradeCount,
          pnl: this.historicalPnl.toFixed(2),
        });
      }
      return trades.length;
    } catch (err) {
      log.warn("Could not load trade history", {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }
}
