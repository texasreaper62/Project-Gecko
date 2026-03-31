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

      // postOrder accepts SignedOrder and orderType string; response is untyped (any)
      const response = await client.postOrder(signedOrder, orderType as never);

      const result: TradeResult = {
        orderId: response?.orderID ?? "unknown",
        status: response?.status === "matched" ? "filled" : "rejected",
        fillPrice: opportunity.params.price,
        fillSize: opportunity.params.size,
        fees: 0,
        timestamp: Date.now(),
      };

      log.info("Order result", {
        opportunityId: opportunity.id,
        orderId: result.orderId,
        status: result.status,
      });

      if (result.status === "filled") {
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
}
