import { createLogger } from "../core/logger.js";
import { withRetry } from "../utils/retry.js";
import { appendJsonl } from "../utils/persistence.js";
import { nowIso } from "../utils/time.js";
import type { Opportunity, TradeResult, FeedHealth } from "../core/types.js";
import type { OrderBuilder } from "./order-builder.js";
import type { RiskManager } from "./risk-manager.js";
import type { PositionTracker } from "./position-tracker.js";

const log = createLogger("order-executor");

export class OrderExecutor {
  private readonly orderBuilder: OrderBuilder;
  private readonly riskManager: RiskManager;
  private readonly positionTracker: PositionTracker;

  constructor(
    orderBuilder: OrderBuilder,
    riskManager: RiskManager,
    positionTracker: PositionTracker,
  ) {
    this.orderBuilder = orderBuilder;
    this.riskManager = riskManager;
    this.positionTracker = positionTracker;
  }

  async executeOpportunity(
    opportunity: Opportunity,
    feedHealths: readonly FeedHealth[],
  ): Promise<TradeResult | null> {
    // Run risk checks
    const riskCheck = this.riskManager.checkTrade(opportunity, feedHealths);
    if (!riskCheck.allowed) {
      log.info("Trade blocked by risk manager", {
        opportunityId: opportunity.id,
        reason: riskCheck.reason,
      });

      // Still log the opportunity
      appendJsonl("data/opportunities.jsonl", {
        ...opportunity,
        ts: nowIso(),
        traded: false,
        reason: riskCheck.reason,
      });

      return null;
    }

    // Skip if we already have a position in this market
    if (this.positionTracker.hasPosition(opportunity.params.conditionId)) {
      log.info("Already have position in this market", {
        conditionId: opportunity.params.conditionId,
      });
      return null;
    }

    try {
      log.info("Executing trade", {
        opportunityId: opportunity.id,
        strategy: opportunity.strategy,
        tokenId: opportunity.params.tokenId,
        side: opportunity.params.side,
        price: opportunity.params.price,
        size: opportunity.params.size,
        orderType: opportunity.params.orderType,
      });

      // Create and submit order with retry
      const result = await withRetry(
        async () => {
          const signedOrder = await this.orderBuilder.createOrder(opportunity.params);
          const client = this.orderBuilder.getClobClient();
          const orderType = this.orderBuilder.getOrderType(opportunity.params.orderType);
          const response = await client.postOrder(signedOrder as never, orderType);
          return response;
        },
        `execute order ${opportunity.id}`,
        { maxAttempts: 2, initialDelay: 500, timeout: 15_000 },
      );

      // Parse response into TradeResult
      const tradeResult = this.parseTradeResult(result);

      log.info("Trade executed", {
        opportunityId: opportunity.id,
        orderId: tradeResult.orderId,
        status: tradeResult.status,
        fillPrice: tradeResult.fillPrice,
        fillSize: tradeResult.fillSize,
      });

      // Track position if filled
      if (tradeResult.status === "filled" || tradeResult.status === "partial") {
        this.positionTracker.openPosition(opportunity, tradeResult);
      }

      // Log opportunity as traded
      appendJsonl("data/opportunities.jsonl", {
        ...opportunity,
        ts: nowIso(),
        traded: true,
        result: tradeResult,
      });

      return tradeResult;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("Trade execution failed", {
        opportunityId: opportunity.id,
        error: errorMsg,
      });

      appendJsonl("data/opportunities.jsonl", {
        ...opportunity,
        ts: nowIso(),
        traded: false,
        reason: `Execution error: ${errorMsg}`,
      });

      return {
        orderId: "",
        status: "error",
        fillPrice: 0,
        fillSize: 0,
        fees: 0,
        timestamp: Date.now(),
        error: errorMsg,
      };
    }
  }

  private parseTradeResult(response: unknown): TradeResult {
    // The CLOB client returns different shapes depending on the endpoint
    // We handle the common fields safely
    const resp = response as Record<string, unknown>;

    const orderId = (resp.orderID ?? resp.order_id ?? resp.id ?? "") as string;
    const status = this.normalizeStatus(resp.status as string | undefined);

    return {
      orderId,
      status,
      fillPrice: typeof resp.price === "number" ? resp.price : 0,
      fillSize: typeof resp.size === "number" ? resp.size : 0,
      fees: typeof resp.fee === "number" ? resp.fee : 0,
      timestamp: Date.now(),
    };
  }

  private normalizeStatus(status: string | undefined): TradeResult["status"] {
    if (!status) return "error";
    const lower = status.toLowerCase();
    if (lower === "matched" || lower === "filled" || lower === "live") return "filled";
    if (lower === "partial" || lower === "partially_filled") return "partial";
    if (lower === "rejected" || lower === "cancelled") return "rejected";
    return "error";
  }
}
