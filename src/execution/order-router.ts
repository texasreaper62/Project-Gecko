// Order router. Single entry point for strategies to submit a TradeSignal.
//
// Flow:
//   1. Build the Schwab order payload from the signal
//   2. Run preview (optional, gated by config -- catches bad shapes before
//      they hit the order book)
//   3. Submit via SchwabRest.placeOrder, get orderId
//   4. Track the pending order. Fill confirmation arrives via ACCT_ACTIVITY
//      (handled separately and dispatched back here via onFill)
//   5. If LIVE_TRADING=false, log the signed payload and stop here.
//
// Note: we do NOT block on fill confirmation. The caller fires-and-forgets;
// the position tracker is updated when the stream pushes the fill.

import { createLogger } from "../core/logger.js";
import { appendJsonl } from "../utils/persistence.js";
import { nowIso } from "../utils/time.js";
import type { AppConfig, TradeSignal } from "../core/types.js";
import type { SchwabRest } from "../brokers/schwab/rest.js";
import type { RiskManager } from "../risk/risk-manager.js";
import type { AccountSnapshot } from "../core/types.js";
import { buildEquityOrder, buildOptionOrder } from "./order-builder.js";

const log = createLogger("order-router");

const SIGNALS_LOG = "data/signals.jsonl";
const ORDERS_LOG = "data/orders.jsonl";

export interface RouterSubmitResult {
  readonly accepted: boolean;
  readonly orderId?: string;
  readonly reason: string;
}

export class OrderRouter {
  constructor(
    private readonly config: AppConfig,
    private readonly rest: SchwabRest,
    private readonly risk: RiskManager,
    private readonly accountHash: string,
  ) {}

  async submit(signal: TradeSignal, account: AccountSnapshot): Promise<RouterSubmitResult> {
    appendJsonl(SIGNALS_LOG, { ts: nowIso(), signal });

    const riskResult = this.risk.check(signal, account);
    if (!riskResult.allowed) {
      return { accepted: false, reason: riskResult.reason };
    }

    return this.dispatch(signal, "live");
  }

  // Submit a close order. Skips position-dedup and position-count caps
  // (we WANT to close the existing position), but still honors kill switch.
  async submitClose(signal: TradeSignal): Promise<RouterSubmitResult> {
    appendJsonl(SIGNALS_LOG, { ts: nowIso(), signal, close: true });

    if (this.risk.isKillSwitchActive()) {
      log.warn("Close blocked: kill switch active", { signalId: signal.id });
      return { accepted: false, reason: "Kill switch active" };
    }

    return this.dispatch(signal, "close");
  }

  private async dispatch(signal: TradeSignal, mode: "live" | "close"): Promise<RouterSubmitResult> {
    let payload;
    try {
      payload = signal.order.instrument.assetClass === "equity"
        ? buildEquityOrder(signal.order)
        : buildOptionOrder(signal.order);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Order build failed", { signalId: signal.id, error: msg });
      return { accepted: false, reason: `build error: ${msg}` };
    }

    if (!this.config.liveTrading) {
      log.info("Dry-run: order built but not submitted", {
        signalId: signal.id,
        strategy: signal.strategy,
        mode,
        payload,
      });
      appendJsonl(ORDERS_LOG, { ts: nowIso(), mode: "dry-run", flow: mode, signal, payload });
      return { accepted: true, reason: "dry-run (LIVE_TRADING=false)" };
    }

    try {
      const { orderId } = await this.rest.placeOrder(this.accountHash, payload);
      appendJsonl(ORDERS_LOG, { ts: nowIso(), mode: "live", flow: mode, signalId: signal.id, orderId, signal, payload });
      log.info("Order submitted", { signalId: signal.id, strategy: signal.strategy, flow: mode, orderId });
      return { accepted: true, orderId, reason: "submitted" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Order submission failed", { signalId: signal.id, flow: mode, error: msg });
      return { accepted: false, reason: `submit error: ${msg}` };
    }
  }

  async cancel(orderId: string): Promise<boolean> {
    if (!this.config.liveTrading) {
      log.info("Dry-run cancel (no-op)", { orderId });
      return true;
    }
    try {
      await this.rest.cancelOrder(this.accountHash, orderId);
      return true;
    } catch (err) {
      log.error("Cancel failed", {
        orderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
