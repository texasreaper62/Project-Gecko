import { createLogger } from "../core/logger.js";
import type { Position, TradeResult, TradeParams, TradeRecord, StrategyType } from "../core/types.js";
import { appendJsonl } from "../utils/persistence.js";
import { nowIso } from "../utils/time.js";

const log = createLogger("position-tracker");

export class PositionTracker {
  private readonly positions: Map<string, Position> = new Map();

  getOpenPositionCount(): number {
    return this.positions.size;
  }

  getTotalExposure(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      total += pos.size;
    }
    return total;
  }

  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  getPosition(tokenId: string): Position | null {
    return this.positions.get(tokenId) ?? null;
  }

  getPositionByCondition(conditionId: string): Position | null {
    for (const pos of this.positions.values()) {
      if (pos.conditionId === conditionId) return pos;
    }
    return null;
  }

  openPosition(
    params: TradeParams,
    result: TradeResult,
    marketQuestion: string,
    strategy: StrategyType,
  ): void {
    const pos: Position = {
      conditionId: params.conditionId,
      tokenId: params.tokenId,
      side: params.side,
      entryPrice: result.fillPrice,
      size: result.fillSize,
      openTimestamp: Date.now(),
      market: marketQuestion,
      currentPrice: result.fillPrice,
      unrealizedPnl: 0,
    };

    this.positions.set(params.tokenId, pos);

    log.info("Position opened", {
      tokenId: params.tokenId,
      side: params.side,
      price: result.fillPrice,
      size: result.fillSize,
    });

    // Record the trade
    const record: TradeRecord = {
      ts: nowIso(),
      market: marketQuestion,
      conditionId: params.conditionId,
      side: params.side,
      tokenId: params.tokenId,
      price: params.price,
      size: params.size,
      orderId: result.orderId,
      status: result.status,
      fillPrice: result.fillPrice,
      fees: result.fees,
      pnl: null,
      strategy,
    };

    appendJsonl("data/trades.jsonl", record);
  }

  closePosition(tokenId: string, exitPrice: number, fees: number): number {
    const pos = this.positions.get(tokenId);
    if (!pos) {
      log.warn("Attempted to close non-existent position", { tokenId });
      return 0;
    }

    // P&L calculation: (exit - entry) * size for BUY, (entry - exit) * size for SELL
    const pnl = pos.side === "BUY"
      ? (exitPrice - pos.entryPrice) * pos.size - fees
      : (pos.entryPrice - exitPrice) * pos.size - fees;

    this.positions.delete(tokenId);

    log.info("Position closed", {
      tokenId,
      entryPrice: pos.entryPrice,
      exitPrice,
      size: pos.size,
      pnl: pnl.toFixed(4),
    });

    return pnl;
  }

  updatePrice(tokenId: string, currentPrice: number): void {
    const pos = this.positions.get(tokenId);
    if (!pos) return;

    pos.currentPrice = currentPrice;
    pos.unrealizedPnl = pos.side === "BUY"
      ? (currentPrice - pos.entryPrice) * pos.size
      : (pos.entryPrice - currentPrice) * pos.size;
  }

  getTotalUnrealizedPnl(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      total += pos.unrealizedPnl;
    }
    return total;
  }
}
