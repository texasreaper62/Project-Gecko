import { createLogger } from "../core/logger.js";
import { nowIso } from "../utils/time.js";
import type { Position, TradeRecord, TradeResult, Opportunity } from "../core/types.js";
import { appendJsonl } from "../utils/persistence.js";

const log = createLogger("position-tracker");

export class PositionTracker {
  private readonly positions: Map<string, Position> = new Map(); // keyed by conditionId
  private totalRealizedPnl = 0;
  private totalFees = 0;
  private tradeCount = 0;

  // Open a new position from a filled trade
  openPosition(opportunity: Opportunity, result: TradeResult): void {
    const position: Position = {
      conditionId: opportunity.params.conditionId,
      tokenId: opportunity.params.tokenId,
      side: opportunity.params.side,
      entryPrice: result.fillPrice,
      size: result.fillSize,
      openTimestamp: result.timestamp,
      market: opportunity.description,
      currentPrice: result.fillPrice,
      unrealizedPnl: 0,
    };

    this.positions.set(opportunity.params.conditionId, position);
    this.tradeCount++;

    log.info("Position opened", {
      conditionId: position.conditionId,
      side: position.side,
      entryPrice: position.entryPrice,
      size: position.size,
    });

    // Record the trade
    const record: TradeRecord = {
      ts: nowIso(),
      market: opportunity.description,
      conditionId: opportunity.params.conditionId,
      side: opportunity.params.side,
      tokenId: opportunity.params.tokenId,
      price: result.fillPrice,
      size: result.fillSize,
      orderId: result.orderId,
      status: result.status,
      fillPrice: result.fillPrice,
      fees: result.fees,
      pnl: null,
      strategy: opportunity.strategy,
    };

    appendJsonl("data/trades.jsonl", record);
  }

  // Close a position and record P&L
  closePosition(conditionId: string, exitPrice: number, fees: number): number | null {
    const position = this.positions.get(conditionId);
    if (!position) {
      log.warn("Attempted to close nonexistent position", { conditionId });
      return null;
    }

    // P&L = (exit - entry) * size for BUY, inverted for SELL
    const pnl = position.side === "BUY"
      ? (exitPrice - position.entryPrice) * position.size
      : (position.entryPrice - exitPrice) * position.size;

    const netPnl = pnl - fees;
    this.totalRealizedPnl += netPnl;
    this.totalFees += fees;

    log.info("Position closed", {
      conditionId,
      entryPrice: position.entryPrice,
      exitPrice,
      size: position.size,
      pnl: netPnl.toFixed(4),
    });

    this.positions.delete(conditionId);
    return netPnl;
  }

  // Update current prices for unrealized P&L
  updatePrice(conditionId: string, currentPrice: number): void {
    const position = this.positions.get(conditionId);
    if (!position) return;

    position.currentPrice = currentPrice;
    position.unrealizedPnl = position.side === "BUY"
      ? (currentPrice - position.entryPrice) * position.size
      : (position.entryPrice - currentPrice) * position.size;
  }

  getPosition(conditionId: string): Position | undefined {
    return this.positions.get(conditionId);
  }

  hasPosition(conditionId: string): boolean {
    return this.positions.has(conditionId);
  }

  getOpenPositionCount(): number {
    return this.positions.size;
  }

  getTotalExposure(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      total += pos.entryPrice * pos.size;
    }
    return total;
  }

  getUnrealizedPnl(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      total += pos.unrealizedPnl;
    }
    return total;
  }

  getRealizedPnl(): number {
    return this.totalRealizedPnl;
  }

  getTotalFees(): number {
    return this.totalFees;
  }

  getTradeCount(): number {
    return this.tradeCount;
  }

  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }
}
