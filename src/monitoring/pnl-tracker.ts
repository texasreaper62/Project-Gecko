import { createLogger } from "../core/logger.js";
import type { PositionTracker } from "../execution/position-tracker.js";
import type { TradeRecord } from "../core/types.js";
import { readJsonl } from "../utils/persistence.js";

const log = createLogger("pnl-tracker");

export class PnlTracker {
  private readonly positions: PositionTracker;
  private realizedPnl = 0;
  private totalFees = 0;
  private tradeCount = 0;
  private winCount = 0;
  private lossCount = 0;

  constructor(positions: PositionTracker) {
    this.positions = positions;
    this.loadHistory();
  }

  recordTrade(pnl: number, fees: number): void {
    this.realizedPnl += pnl;
    this.totalFees += fees;
    this.tradeCount++;
    if (pnl > 0) this.winCount++;
    else if (pnl < 0) this.lossCount++;
  }

  getRealizedPnl(): number {
    return this.realizedPnl;
  }

  getUnrealizedPnl(): number {
    return this.positions.getTotalUnrealizedPnl();
  }

  getTotalPnl(): number {
    return this.realizedPnl + this.getUnrealizedPnl();
  }

  getNetPnl(): number {
    return this.getTotalPnl() - this.totalFees;
  }

  getWinRate(): number {
    if (this.tradeCount === 0) return 0;
    return this.winCount / this.tradeCount;
  }

  getSummary(): string {
    return [
      `Realized P&L: $${this.realizedPnl.toFixed(2)}`,
      `Unrealized P&L: $${this.getUnrealizedPnl().toFixed(2)}`,
      `Net P&L: $${this.getNetPnl().toFixed(2)}`,
      `Total Fees: $${this.totalFees.toFixed(2)}`,
      `Trades: ${this.tradeCount} (${this.winCount}W/${this.lossCount}L)`,
      `Win Rate: ${(this.getWinRate() * 100).toFixed(1)}%`,
      `Open Positions: ${this.positions.getOpenPositionCount()}`,
      `Total Exposure: $${this.positions.getTotalExposure().toFixed(2)}`,
    ].join("\n");
  }

  private loadHistory(): void {
    try {
      const trades = readJsonl<TradeRecord>("data/trades.jsonl");
      for (const t of trades) {
        if (t.pnl !== null) {
          this.realizedPnl += t.pnl;
          this.tradeCount++;
          if (t.pnl > 0) this.winCount++;
          else if (t.pnl < 0) this.lossCount++;
        }
        this.totalFees += t.fees;
      }
      if (trades.length > 0) {
        log.info("Loaded trade history", { trades: trades.length, pnl: this.realizedPnl.toFixed(2) });
      }
    } catch (err) {
      log.warn("Could not load trade history", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
