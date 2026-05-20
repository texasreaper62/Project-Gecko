// PositionMonitor: closes open positions when exit conditions hit.
//
// Each open position carries metadata set by the strategy at signal time:
//   - stopPrice, takeProfitPrice
//   - timeStopMs (engine-specific: ORB = 11:30 ET, Engine B = 30 min from
//     entry or 14:00 ET, whichever is sooner)
//
// We poll every PROBE_INTERVAL_MS:
//   - Read current price from QuoteCache (filled by stream data handler)
//   - Update position-tracker.updatePrice (drives unrealized P&L)
//   - If price crosses stop or take-profit, or time-stop hit, submit a
//     market-equivalent exit order via the router
//
// For equities: exit with a LIMIT order at the touched stop/TP price.
// For options: exit with a LIMIT at current bid (or mark fallback).
// We do NOT use MARKET on options (wide spreads can pay through the book).

import { createLogger } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import type {
  Instrument,
  Position,
  TradeSignal,
} from "../core/types.js";
import type { OrderRouter } from "./order-router.js";
import type { PositionTracker } from "./position-tracker.js";
import type { FillWatcher } from "./fill-watcher.js";
import type { QuoteCache } from "../data/quote-cache.js";

const log = createLogger("position-monitor");

const PROBE_INTERVAL_MS = 2_000;

// Time stops, in absolute ET minutes-of-day.
const ORB_TIME_STOP_MIN = 11 * 60 + 30;     // 11:30 ET
const DTE0_TIME_STOP_MIN = 14 * 60;          // 14:00 ET
// Engine B per-position idle stop: 30 minutes after entry with no movement.
const DTE0_IDLE_MS = 30 * 60 * 1000;
const DTE0_IDLE_NO_MOVE_PCT = 5;             // within 5% of entry = "no movement"

export class PositionMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlightCloses: Set<string> = new Set();

  constructor(
    private readonly positions: PositionTracker,
    private readonly router: OrderRouter,
    private readonly quotes: QuoteCache,
    private readonly fillWatcher: FillWatcher,
    private readonly liveTrading: boolean,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.probe().catch((err) => {
        log.error("Probe failed", { error: errMsg(err) });
      });
    }, PROBE_INTERVAL_MS);
    log.info("Position monitor started", { intervalMs: PROBE_INTERVAL_MS });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async probe(): Promise<void> {
    const open = this.positions.all();
    if (open.length === 0) return;

    const now = Date.now();
    const minsOfDay = nowEtMinutes(now);

    for (const pos of open) {
      const key = instrumentKey(pos.instrument);
      if (this.inFlightCloses.has(key)) continue;

      const price = this.quotes.getPrice(pos.instrument);
      if (price === null) continue;

      this.positions.updatePrice(pos.instrument, price);

      const reason = this.shouldClose(pos, price, minsOfDay, now);
      if (!reason) continue;

      this.inFlightCloses.add(key);
      this.submitClose(pos, price, reason)
        .catch((err) => log.error("Close submit failed", { key, error: errMsg(err) }))
        .finally(() => this.inFlightCloses.delete(key));
    }
  }

  private shouldClose(pos: Position, price: number, minsOfDay: number, now: number): string | null {
    const stop = typeof pos.metadata.stop === "number" ? (pos.metadata.stop as number) : null;
    const take = typeof pos.metadata.take === "number" ? (pos.metadata.take as number) : null;

    if (pos.side === "LONG") {
      if (stop !== null && price <= stop) return `stop ${price.toFixed(2)} <= ${stop.toFixed(2)}`;
      if (take !== null && price >= take) return `take ${price.toFixed(2)} >= ${take.toFixed(2)}`;
    } else {
      if (stop !== null && price >= stop) return `stop ${price.toFixed(2)} >= ${stop.toFixed(2)}`;
      if (take !== null && price <= take) return `take ${price.toFixed(2)} <= ${take.toFixed(2)}`;
    }

    // Engine-specific time and idle stops.
    if (pos.strategy === "orb") {
      if (minsOfDay >= ORB_TIME_STOP_MIN) return "ORB 11:30 ET time-stop";
    }
    if (pos.strategy === "dte0-spy") {
      if (minsOfDay >= DTE0_TIME_STOP_MIN) return "Engine B 14:00 ET time-stop";
      const holdMs = now - pos.openTimestamp;
      if (holdMs > DTE0_IDLE_MS) {
        const movePct = pos.entryPrice > 0 ? Math.abs(price - pos.entryPrice) / pos.entryPrice * 100 : 0;
        if (movePct < DTE0_IDLE_NO_MOVE_PCT) {
          return `Engine B idle ${(holdMs / 60000).toFixed(0)}min, move ${movePct.toFixed(1)}%`;
        }
      }
    }

    return null;
  }

  private async submitClose(
    pos: Position,
    currentPrice: number,
    reason: string,
  ): Promise<void> {
    log.info("Closing position", {
      strategy: pos.strategy,
      instrument: instrumentKey(pos.instrument),
      reason,
      entry: pos.entryPrice,
      current: currentPrice,
    });

    // Build a close signal that mirrors the open but in reverse.
    const isLong = pos.side === "LONG";
    const isEquity = pos.instrument.assetClass === "equity";
    const signal: TradeSignal = {
      id: `close-${instrumentKey(pos.instrument)}-${Date.now()}`,
      strategy: pos.strategy,
      timestamp: Date.now(),
      description: `CLOSE ${pos.strategy} ${pos.side} ${instrumentKey(pos.instrument)} reason=${reason}`,
      order: {
        instrument: pos.instrument,
        side: isEquity
          ? (isLong ? "SELL" : "BUY")
          : "SELL_TO_CLOSE",
        quantity: pos.quantity,
        orderType: "LIMIT",
        timeInForce: "DAY",
        limitPrice: currentPrice,
      },
      stopPrice: 0,
      takeProfitPrice: 0,
      riskUsd: 0,
      rewardUsd: 0,
      metadata: { closeReason: reason, openTimestamp: pos.openTimestamp },
    };

    const result = await this.router.submitClose(signal);
    if (!result.accepted) {
      log.error("Close order rejected", {
        instrument: instrumentKey(pos.instrument),
        reason: result.reason,
      });
      return;
    }
    if (result.orderId && this.liveTrading) {
      this.fillWatcher.watch(result.orderId, signal, "close");
    }
  }
}

function instrumentKey(i: Instrument): string {
  return i.assetClass === "equity" ? `EQ:${i.symbol}` : `OPT:${i.osiSymbol}`;
}

function nowEtMinutes(ts: number): number {
  const p = etParts(ts);
  return p.hour * 60 + p.minute;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
