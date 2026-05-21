// FillWatcher: polls Schwab for order status after submission and, on fill,
// hydrates the in-memory position tracker.
//
// Why polling vs parsing ACCT_ACTIVITY:
//   ACCT_ACTIVITY pushes order events in real time, but the messages embed
//   XML payloads in JSON content that require schema-specific parsing per
//   message type. For the MVP we poll getOrder() at a 2-second cadence.
//   Each poll is one HTTP call. We're well under the 120 req/min ceiling.
//
// Lifecycle per watched order:
//   - submitted (initial)
//   - polled every POLL_INTERVAL_MS until terminal status or timeout
//   - on FILLED / partial-with-quantity: open position in tracker
//   - on REJECTED / CANCELED: log, drop
//   - on timeout: best-effort cancel, log

import { createLogger } from "../core/logger.js";
import { nowIso } from "../utils/time.js";
import type { Position, TradeSignal } from "../core/types.js";
import type { Broker, BrokerOrderStatus } from "../brokers/broker.js";
import type { PositionTracker } from "./position-tracker.js";
import type { SelfTuner } from "../intelligence/self-tuner.js";

const log = createLogger("fill-watcher");

const POLL_INTERVAL_MS = 2_000;
const POLL_DEADLINE_MS = 30_000;

interface WatchedOrder {
  readonly orderId: string;
  readonly signal: TradeSignal;
  readonly mode: "open" | "close";
  readonly deadline: number;
}

export class FillWatcher {
  private readonly watched: Map<string, WatchedOrder> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly broker: Broker,
    private readonly positions: PositionTracker,
    private readonly tuner: SelfTuner | null = null,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch((err) => log.error("Poll cycle failed", { error: errMsg(err) }));
    }, POLL_INTERVAL_MS);
    log.info("Fill watcher started", { intervalMs: POLL_INTERVAL_MS });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  watch(orderId: string, signal: TradeSignal, mode: "open" | "close"): void {
    this.watched.set(orderId, {
      orderId,
      signal,
      mode,
      deadline: Date.now() + POLL_DEADLINE_MS,
    });
    log.info("Watching order", { orderId, mode, strategy: signal.strategy });
  }

  private async poll(): Promise<void> {
    if (this.watched.size === 0) return;
    const now = Date.now();

    for (const [orderId, w] of this.watched) {
      try {
        const status = await this.broker.getOrderStatus(orderId);
        if (!status) {
          if (now > w.deadline) { this.watched.delete(orderId); }
          continue;
        }

        if (status.status === "FILLED") {
          this.onFill(w, status);
          this.watched.delete(orderId);
          continue;
        }
        if (status.status === "REJECTED" || status.status === "CANCELED" || status.status === "EXPIRED") {
          log.warn("Order ended without fill", { orderId, status: status.status, mode: w.mode });
          this.watched.delete(orderId);
          continue;
        }
        // Otherwise: WORKING / PARTIAL. Keep polling.

        if (now > w.deadline) {
          log.warn("Fill timeout, cancelling", { orderId, mode: w.mode });
          this.broker.cancelOrder(orderId).catch((err) =>
            log.warn("Cancel-on-timeout failed", { orderId, error: errMsg(err) }),
          );
          this.watched.delete(orderId);
        }
      } catch (err) {
        // Schwab may briefly 404 a freshly-placed order. Tolerate transient errors
        // until the deadline; then give up.
        if (now > w.deadline) {
          log.error("Fill poll deadline elapsed with errors", {
            orderId,
            error: errMsg(err),
          });
          this.watched.delete(orderId);
        }
      }
    }
  }

  private onFill(w: WatchedOrder, status: BrokerOrderStatus): void {
    const fill = { quantity: status.filledQuantity, price: status.avgPrice, fees: 0 };
    if (fill.quantity <= 0 || !Number.isFinite(fill.price) || fill.price <= 0) {
      log.warn("Order marked FILLED but fill data missing", { orderId: w.orderId });
      return;
    }

    if (w.mode === "open") {
      this.openFromFill(w.signal, fill);
    } else {
      this.closeFromFill(w.signal, fill);
    }
  }

  private openFromFill(signal: TradeSignal, fill: { quantity: number; price: number; fees: number }): void {
    const side: Position["side"] = signal.order.side === "BUY"
      || signal.order.side === "BUY_TO_OPEN"
      ? "LONG"
      : "SHORT";

    this.positions.open({
      instrument: signal.order.instrument,
      side,
      entryPrice: fill.price,
      quantity: fill.quantity,
      strategy: signal.strategy,
      metadata: {
        ...signal.metadata,
        stop: signal.stopPrice,
        take: signal.takeProfitPrice,
        riskUsd: signal.riskUsd,
        rewardUsd: signal.rewardUsd,
        signalId: signal.id,
      },
    });
  }

  private closeFromFill(signal: TradeSignal, fill: { quantity: number; price: number; fees: number }): void {
    const result = this.positions.close(signal.order.instrument, fill.price, fill.fees);
    if (!result) {
      log.warn("Close fill received but no tracked position to close", {
        signalId: signal.id,
      });
      return;
    }
    if (this.tuner) {
      this.tuner.recordOutcome({
        ts: nowIso(),
        key: signal.order.instrument.assetClass === "equity"
          ? `EQ:${signal.order.instrument.symbol}`
          : `OPT:${signal.order.instrument.osiSymbol}`,
        strategy: result.position.strategy,
        side: result.position.side,
        qty: result.position.quantity,
        entryPrice: result.position.entryPrice,
        exitPrice: fill.price,
        fees: fill.fees,
        pnl: result.pnl,
        holdMs: Date.now() - result.position.openTimestamp,
        metadata: result.position.metadata,
      });
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
