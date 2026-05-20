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
import type { Position, TradeSignal } from "../core/types.js";
import type { SchwabRest } from "../brokers/schwab/rest.js";
import type {
  SchwabOrderActivity,
  SchwabOrderResponse,
} from "../brokers/schwab/types.js";
import type { PositionTracker } from "./position-tracker.js";

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
    private readonly rest: SchwabRest,
    private readonly positions: PositionTracker,
    private readonly accountHash: string,
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
        const order = await this.rest.getOrder(this.accountHash, orderId);
        const status = order.status.toUpperCase();

        if (status === "FILLED" || status === "REPLACED" /* edge case */) {
          this.onFill(w, order);
          this.watched.delete(orderId);
          continue;
        }
        if (
          status === "REJECTED" ||
          status === "CANCELED" ||
          status === "EXPIRED"
        ) {
          log.warn("Order ended without fill", { orderId, status, mode: w.mode });
          this.watched.delete(orderId);
          continue;
        }
        // Otherwise: WORKING / PENDING_* / AWAITING_* / etc. Keep polling.

        if (now > w.deadline) {
          log.warn("Fill timeout, cancelling", { orderId, mode: w.mode });
          this.rest.cancelOrder(this.accountHash, orderId).catch((err) =>
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

  private onFill(w: WatchedOrder, order: SchwabOrderResponse): void {
    const fill = aggregateFill(order);
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
    }
  }
}

function aggregateFill(order: SchwabOrderResponse): { quantity: number; price: number; fees: number } {
  // Sum fill quantities and weighted-average prices across executionLegs.
  let qty = 0;
  let notional = 0;
  for (const activity of order.orderActivityCollection ?? []) {
    if (activity.activityType !== "EXECUTION") continue;
    for (const leg of activity.executionLegs ?? []) {
      if (!Number.isFinite(leg.price) || !Number.isFinite(leg.quantity)) continue;
      qty += leg.quantity;
      notional += leg.price * leg.quantity;
    }
  }
  const price = qty > 0 ? notional / qty : 0;
  // Schwab includes fee data on the order; not all SDKs surface it. Default to 0.
  return { quantity: qty, price, fees: 0 };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
