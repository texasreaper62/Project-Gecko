import { createLogger } from "../core/logger.js";
import type { AppConfig, Opportunity, TradeResult, TradeParams } from "../core/types.js";
import type { OrderBuilder } from "./order-builder.js";
import type { RiskManager } from "./risk-manager.js";
import type { PositionTracker } from "./position-tracker.js";
import type { PolymarketRestClient } from "../feeds/polymarket-rest.js";
import { appendJsonl } from "../utils/persistence.js";
import { nowIso } from "../utils/time.js";

const log = createLogger("order-executor");

// Circuit breaker: pause after N consecutive losses
const MAX_CONSECUTIVE_LOSSES = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 300_000; // 5 minutes

// Response shape we expect from postOrder (runtime validated)
interface PostOrderResponse {
  orderID?: string;
  order_id?: string;
  status?: string;
  price?: number;
  size?: number;
  fee?: number;
}

export class OrderExecutor {
  private readonly config: AppConfig;
  private readonly orderBuilder: OrderBuilder;
  private readonly riskManager: RiskManager;
  private readonly positions: PositionTracker;
  private readonly polyRest: PolymarketRestClient;

  // Execution mutex: only one trade at a time
  private executing = false;

  // Circuit breaker state
  private consecutiveLosses = 0;
  private circuitBreakerUntil = 0;

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

  recordTradeResult(pnl: number): void {
    if (pnl < 0) {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
        this.circuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
        log.warn("Circuit breaker tripped", {
          consecutiveLosses: this.consecutiveLosses,
          cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
        });
      }
    } else if (pnl > 0) {
      this.consecutiveLosses = 0;
    }
  }

  // Submit a sell order to actually close a position on-exchange
  async submitSellOrder(params: TradeParams): Promise<TradeResult | null> {
    const sellParams: TradeParams = {
      ...params,
      side: "SELL",
      orderType: "FOK",
    };

    try {
      const { signedOrder, orderType } = await this.orderBuilder.createOrder(sellParams);
      const client = this.orderBuilder.getClient();
      if (!client) throw new Error("CLOB client not available");

      const response = await client.postOrder(signedOrder, orderType as never);
      const validated = this.validateResponse(response);
      const status = this.normalizeOrderStatus(validated.status);

      const result: TradeResult = {
        orderId: validated.orderID ?? validated.order_id ?? "unknown",
        status,
        fillPrice: typeof validated.price === "number" ? validated.price : params.price,
        fillSize: typeof validated.size === "number" ? validated.size : params.size,
        fees: typeof validated.fee === "number" ? validated.fee : 0,
        timestamp: Date.now(),
      };

      log.info("Sell order result", {
        tokenId: params.tokenId,
        status: result.status,
        orderId: result.orderId,
      });

      return result;
    } catch (err) {
      log.error("Sell order failed", {
        tokenId: params.tokenId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // Cancel all open orders on the exchange
  async cancelAllOrders(): Promise<void> {
    const client = this.orderBuilder.getClient();
    if (!client) {
      log.warn("Cannot cancel orders: CLOB client not available");
      return;
    }

    try {
      await client.cancelAll();
      log.info("All open orders cancelled");
    } catch (err) {
      log.error("Failed to cancel all orders", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async executeOpportunity(opportunity: Opportunity): Promise<TradeResult | null> {
    // Log every opportunity regardless
    appendJsonl("data/opportunities.jsonl", {
      ts: nowIso(),
      ...opportunity,
    });

    // Execution mutex: reject if another trade is in flight
    if (this.executing) {
      log.info("Skipping opportunity, another trade in flight", {
        opportunityId: opportunity.id,
      });
      return null;
    }

    // Circuit breaker check
    if (Date.now() < this.circuitBreakerUntil) {
      log.warn("Circuit breaker active, skipping trade", {
        opportunityId: opportunity.id,
        resumesIn: `${((this.circuitBreakerUntil - Date.now()) / 1000).toFixed(0)}s`,
      });
      return null;
    }

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

    // Acquire execution lock
    this.executing = true;

    try {
      return await this.submitOrder(opportunity);
    } finally {
      this.executing = false;
    }
  }

  private async submitOrder(opportunity: Opportunity): Promise<TradeResult | null> {
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

      // Dry-run mode: sign but don't submit
      if (!this.config.liveTrading) {
        log.info("Dry-run: order signed but not submitted", {
          opportunityId: opportunity.id,
          orderType,
        });
        return {
          orderId: "dry-run",
          status: "rejected",
          fillPrice: 0,
          fillSize: 0,
          fees: 0,
          timestamp: Date.now(),
        };
      }

      // Submit order and validate response
      const rawResponse = await client.postOrder(signedOrder, orderType as never);
      const response = this.validateResponse(rawResponse);
      const status = this.normalizeOrderStatus(response.status);

      const result: TradeResult = {
        orderId: response.orderID ?? response.order_id ?? "unknown",
        status,
        fillPrice: typeof response.price === "number" ? response.price : opportunity.params.price,
        fillSize: typeof response.size === "number" ? response.size : opportunity.params.size,
        fees: typeof response.fee === "number" ? response.fee : 0,
        timestamp: Date.now(),
      };

      log.info("Order result", {
        opportunityId: opportunity.id,
        orderId: result.orderId,
        status: result.status,
        rawStatus: response.status,
        rawResponse: JSON.stringify(rawResponse).slice(0, 500),
      });

      if (result.status === "filled" || result.status === "partial") {
        this.positions.openPosition(
          opportunity.params,
          result,
          opportunity.description,
          opportunity.strategy,
          { ...opportunity.metadata, opportunityId: opportunity.id, expectedSpread: opportunity.expectedSpread },
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

  // Runtime validation of the untyped postOrder response
  private validateResponse(raw: unknown): PostOrderResponse {
    if (raw === null || raw === undefined) {
      log.warn("postOrder returned null/undefined response");
      return {};
    }

    if (typeof raw !== "object") {
      log.warn("postOrder returned non-object response", { type: typeof raw });
      return {};
    }

    const resp = raw as Record<string, unknown>;

    // Log the full response shape on first few calls for debugging
    log.debug("postOrder raw response fields", {
      keys: Object.keys(resp).join(", "),
    });

    return {
      orderID: typeof resp.orderID === "string" ? resp.orderID : undefined,
      order_id: typeof resp.order_id === "string" ? resp.order_id : undefined,
      status: typeof resp.status === "string" ? resp.status : undefined,
      price: typeof resp.price === "number" ? resp.price : undefined,
      size: typeof resp.size === "number" ? resp.size : undefined,
      fee: typeof resp.fee === "number" ? resp.fee : undefined,
    };
  }

  private normalizeOrderStatus(raw: string | undefined): "filled" | "partial" | "rejected" | "error" {
    const s = (raw ?? "").toLowerCase();
    if (s === "matched" || s === "filled") return "filled";
    if (s === "partial" || s === "partially_filled") return "partial";
    if (s === "live" || s === "open") return "partial";
    return "rejected";
  }
}
