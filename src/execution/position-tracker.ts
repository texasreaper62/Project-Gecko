// In-memory position tracker. Owns the source of truth for what we are
// holding RIGHT NOW (from our perspective). Schwab is the actual authority;
// we reconcile on startup and via ACCT_ACTIVITY pushes.

import { createLogger } from "../core/logger.js";
import { appendJsonl } from "../utils/persistence.js";
import { nowIso } from "../utils/time.js";
import type { Instrument, Position, StrategyType } from "../core/types.js";

const log = createLogger("position-tracker");

const POSITIONS_LOG = "data/positions.jsonl";
const OUTCOMES_LOG = "data/outcomes.jsonl";

export class PositionTracker {
  private positions: Map<string, Position> = new Map();

  open(args: {
    readonly instrument: Instrument;
    readonly side: "LONG" | "SHORT";
    readonly entryPrice: number;
    readonly quantity: number;
    readonly strategy: StrategyType;
    readonly metadata: Record<string, unknown>;
  }): Position {
    const key = instrumentKey(args.instrument);
    const position: Position = {
      instrument: args.instrument,
      side: args.side,
      entryPrice: args.entryPrice,
      quantity: args.quantity,
      openTimestamp: Date.now(),
      strategy: args.strategy,
      metadata: args.metadata,
      currentPrice: args.entryPrice,
      unrealizedPnl: 0,
    };
    this.positions.set(key, position);
    appendJsonl(POSITIONS_LOG, { ts: nowIso(), event: "open", key, position });
    log.info("Position opened", {
      key,
      side: position.side,
      qty: position.quantity,
      entry: position.entryPrice,
    });
    return position;
  }

  updatePrice(instrument: Instrument, currentPrice: number): void {
    const key = instrumentKey(instrument);
    const pos = this.positions.get(key);
    if (!pos) return;
    pos.currentPrice = currentPrice;
    const directionMul = pos.side === "LONG" ? 1 : -1;
    const contractMul = instrument.assetClass === "option" ? 100 : 1;
    pos.unrealizedPnl = (currentPrice - pos.entryPrice) * pos.quantity * directionMul * contractMul;
  }

  close(instrument: Instrument, exitPrice: number, fees: number): { pnl: number; position: Position } | null {
    const key = instrumentKey(instrument);
    const pos = this.positions.get(key);
    if (!pos) return null;

    const directionMul = pos.side === "LONG" ? 1 : -1;
    const contractMul = instrument.assetClass === "option" ? 100 : 1;
    const pnl = (exitPrice - pos.entryPrice) * pos.quantity * directionMul * contractMul - fees;

    this.positions.delete(key);
    appendJsonl(OUTCOMES_LOG, {
      ts: nowIso(),
      key,
      strategy: pos.strategy,
      side: pos.side,
      qty: pos.quantity,
      entryPrice: pos.entryPrice,
      exitPrice,
      fees,
      pnl,
      holdMs: Date.now() - pos.openTimestamp,
      metadata: pos.metadata,
    });
    log.info("Position closed", {
      key,
      pnl: pnl.toFixed(2),
      holdMs: Date.now() - pos.openTimestamp,
    });
    return { pnl, position: pos };
  }

  get(instrument: Instrument): Position | null {
    return this.positions.get(instrumentKey(instrument)) ?? null;
  }

  hasInstrument(instrument: Instrument): boolean {
    return this.positions.has(instrumentKey(instrument));
  }

  all(): readonly Position[] {
    return Array.from(this.positions.values());
  }

  countByAssetClass(assetClass: "equity" | "option"): number {
    let n = 0;
    for (const p of this.positions.values()) {
      if (p.instrument.assetClass === assetClass) n++;
    }
    return n;
  }

  unrealizedPnl(): number {
    let total = 0;
    for (const p of this.positions.values()) total += p.unrealizedPnl;
    return total;
  }
}

function instrumentKey(i: Instrument): string {
  return i.assetClass === "equity" ? `EQ:${i.symbol}` : `OPT:${i.osiSymbol}`;
}
