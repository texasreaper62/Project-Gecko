import { createLogger } from "../core/logger.js";
import type { PositionTracker } from "../execution/position-tracker.js";

const log = createLogger("pnl-tracker");

export class PnlTracker {
  private readonly positionTracker: PositionTracker;

  constructor(positionTracker: PositionTracker) {
    this.positionTracker = positionTracker;
  }

  getRealizedPnl(): number {
    return this.positionTracker.getRealizedPnl();
  }

  getUnrealizedPnl(): number {
    return this.positionTracker.getUnrealizedPnl();
  }

  getTotalPnl(): number {
    return this.getRealizedPnl() + this.getUnrealizedPnl();
  }

  getTotalFees(): number {
    return this.positionTracker.getTotalFees();
  }

  getNetPnl(): number {
    return this.getTotalPnl() - this.getTotalFees();
  }

  getSummary(): string {
    const realized = this.getRealizedPnl();
    const unrealized = this.getUnrealizedPnl();
    const fees = this.getTotalFees();
    const net = this.getNetPnl();
    const trades = this.positionTracker.getTradeCount();
    const positions = this.positionTracker.getOpenPositionCount();

    return [
      `P&L Summary:`,
      `  Realized: $${realized.toFixed(4)}`,
      `  Unrealized: $${unrealized.toFixed(4)}`,
      `  Fees: $${fees.toFixed(4)}`,
      `  Net: $${net.toFixed(4)}`,
      `  Trades: ${trades}`,
      `  Open positions: ${positions}`,
    ].join("\n");
  }

  logSummary(): void {
    log.info("P&L summary", {
      realized: this.getRealizedPnl(),
      unrealized: this.getUnrealizedPnl(),
      fees: this.getTotalFees(),
      net: this.getNetPnl(),
      trades: this.positionTracker.getTradeCount(),
      openPositions: this.positionTracker.getOpenPositionCount(),
    });
  }
}
