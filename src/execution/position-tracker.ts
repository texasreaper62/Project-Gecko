import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import type { Position, TradeResult, TradeParams, TradeRecord, StrategyType } from "../core/types.js";
import { appendJsonl, readJsonl } from "../utils/persistence.js";
import { nowIso } from "../utils/time.js";

const log = createLogger("position-tracker");

const POSITIONS_FILE = "data/positions.jsonl";

export class PositionTracker {
  private readonly positions: Map<string, Position> = new Map();

  constructor() {
    this.loadOpenPositions();
  }

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
    opportunityMetadata?: Record<string, unknown>,
  ): void {
    const pos: Position = {
      conditionId: params.conditionId,
      tokenId: params.tokenId,
      side: params.side,
      entryPrice: result.fillPrice,
      size: result.fillSize,
      openTimestamp: Date.now(),
      market: marketQuestion,
      strategy,
      opportunityMetadata: opportunityMetadata ?? {},
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

    // Record the trade (open)
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
    this.persistOpenPositions();
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

    // Record the close event with realized P&L
    const closeRecord: TradeRecord = {
      ts: nowIso(),
      market: pos.market,
      conditionId: pos.conditionId,
      side: pos.side === "BUY" ? "SELL" : "BUY",
      tokenId: pos.tokenId,
      price: exitPrice,
      size: pos.size,
      orderId: "",
      status: "closed",
      fillPrice: exitPrice,
      fees,
      pnl,
      strategy: pos.strategy,
    };

    appendJsonl("data/trades.jsonl", closeRecord);
    this.persistOpenPositions();

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

  private persistOpenPositions(): void {
    // Overwrite positions file with current open positions
    try {
      const dir = path.dirname(POSITIONS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const lines = Array.from(this.positions.values())
        .map((p) => JSON.stringify(p))
        .join("\n");
      fs.writeFileSync(POSITIONS_FILE, lines ? lines + "\n" : "", "utf-8");
    } catch (err) {
      log.error("Failed to persist open positions", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private loadOpenPositions(): void {
    try {
      const positions = readJsonl<Position>(POSITIONS_FILE);
      for (const pos of positions) {
        if (pos.tokenId && pos.conditionId) {
          this.positions.set(pos.tokenId, pos);
        }
      }
      if (positions.length > 0) {
        log.info("Restored open positions from disk", {
          count: positions.length,
          exposure: this.getTotalExposure().toFixed(2),
        });
      }
    } catch (err) {
      log.warn("Could not load open positions", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
