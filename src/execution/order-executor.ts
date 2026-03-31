import { createLogger } from "../core/logger.js";
import type { AppConfig, Opportunity, TradeResult, StrategyType } from "../core/types.js";
import type { OrderBuilder } from "./order-builder.js";
import type { RiskManager } from "./risk-manager.js";
import type { PositionTracker } from "./position-tracker.js";
import type { PolymarketRestClient } from "../feeds/polymarket-rest.js";
import { appendJsonl } from "../utils/persistence.js";
import { nowIso } from "../utils/time.js";

const log = createLogger("order-executor");

export class OrderExecutor {
  private readonly config: AppConfig;
  private readonly orderBuilder: OrderBuilder;
  private readonly riskManager: RiskManager;
  private readonly positions: PositionTracker;
  private readonly polyRest: PolymarketRestClient;

  constructor(
    config: AppConfig,
    orderBuilder: OrderBuilder,
    riskManager: RiskManager,
    positions: PositionTracker,
    polyRest: PolymarketRestClient,
  ) {
    this.config = config;
    this.orderBuilder = orderBuilder;
    this.riskManager = riskManager;
    this.positions = positions;
    this.polyRest = polyRest;
  }

  async executeOpportunity(opportunity: Opportunity): Promise<TradeResult | null> {
    // Log every opportunity regardless
    appendJsonl("data/opportunities.jsonl", {
      ts: nowIso(),
      ...opportunity,
    });

    // Validate params
    if (opportunity.params.size <= 0 || opportunity.params.price <= 0) {
      log.warn("Invalid trade params", {
        price: opportunity.params.price,
        size: opportunity.params.size,
      });
      return null;
    }

    // Position dedup: don't open a second position on the same market
    if (this.positions.getPositionByCondition(opportunity.params.conditionId)) {
      log.info("Already have position in this market", {
        conditionId: opportunity.params.conditionId,
      });
      return null;
    }

    // Risk check
    const riskResult = this.riskManager.checkTrade(opportunity);
    if (!riskResult.allowed) {
      log.info("Trade blocked by risk manager", {
        opportunityId: opportunity.id,
        reason: riskResult.reason,
      });
      return null;
    }

    // Liquidity check
    try {
      const book = await this.polyRest.getOrderBook(opportunity.params.tokenId);
      if (book.depth < this.config.minLiquidity) {
        log.warn("Insufficient liquidity", {
          tokenId: opportunity.params.tokenId,
          depth: book.depth,
          required: this.config.minLiquidity,
        });
        return null;
      }
    } catch (err) {
      log.error("Failed to check liquidity", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    // Build and submit order
    try {
      log.info("Submitting order", {
        opportunityId: opportunity.id,
        tokenId: opportunity.params.tokenId,
        side: opportunity.params.side,
        price: opportunity.params.price,
        size: opportunity.params.size,
        orderType: opportunity.params.orderType,
      });

      const { signedOrder, orderType } = await this.orderBuilder.createOrder(opportunity.params);

      const client = this.orderBuilder.getClient();
      if (!client) {
        throw new Error("CLOB client not available");
      }

      // postOrder returns any; extract what we can from response
      const response = await client.postOrder(signedOrder, orderType as never);
      const status = this.normalizeOrderStatus(response?.status);

      const result: TradeResult = {
        orderId: response?.orderID ?? response?.order_id ?? "unknown",
        status,
        fillPrice: typeof response?.price === "number" ? response.price : opportunity.params.price,
        fillSize: typeof response?.size === "number" ? response.size : opportunity.params.size,
        fees: typeof response?.fee === "number" ? response.fee : 0,
        timestamp: Date.now(),
      };

      log.info("Order result", {
        opportunityId: opportunity.id,
        orderId: result.orderId,
        status: result.status,
        rawStatus: response?.status,
      });

      if (result.status === "filled" || result.status === "partial") {
        this.positions.openPosition(
          opportunity.params,
          result,
          opportunity.description,
          opportunity.strategy,
        );
      }

      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("Order execution failed", {
        opportunityId: opportunity.id,
        error: errorMsg,
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

  private normalizeOrderStatus(raw: unknown): "filled" | "partial" | "rejected" | "error" {
    const s = typeof raw === "string" ? raw.toLowerCase() : "";
    if (s === "matched" || s === "filled") return "filled";
    if (s === "partial" || s === "partially_filled") return "partial";
    if (s === "live" || s === "open") return "partial"; // Order resting on book
    return "rejected";
  }
}
