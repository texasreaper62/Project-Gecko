import { createLogger } from "../core/logger.js";
import { sumProbabilities } from "../utils/math.js";
import { PolymarketRestClient } from "../feeds/polymarket-rest.js";
import type { AppConfig, Opportunity, StrategyState } from "../core/types.js";
import type { CorrelatedContractSignal } from "./strategy-types.js";

const log = createLogger("correlated-contracts");

// Scan every 60 seconds
const SCAN_INTERVAL = 60_000;
// Minimum deviation from 1.0 to flag (as decimal, e.g., 0.03 = 3%)
const MIN_DEVIATION = 0.03;

export class CorrelatedContractsStrategy {
  readonly name = "correlated-contracts" as const;
  private readonly config: AppConfig;
  private readonly restClient: PolymarketRestClient;

  private scanTimer: ReturnType<typeof setInterval> | null = null;

  private _state: StrategyState = {
    enabled: false,
    lastScan: 0,
    opportunitiesFound: 0,
    tradesExecuted: 0,
  };

  private onOpportunity: ((opp: Opportunity) => void) | null = null;

  constructor(config: AppConfig, restClient: PolymarketRestClient) {
    this.config = config;
    this.restClient = restClient;
  }

  get state(): StrategyState {
    return this._state;
  }

  setOpportunityHandler(handler: (opp: Opportunity) => void): void {
    this.onOpportunity = handler;
  }

  start(): void {
    this._state = { ...this._state, enabled: true };
    log.info("Starting correlated contracts strategy");

    // Run immediately, then on interval
    this.scan().catch((err) => {
      log.error("Initial scan error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.scanTimer = setInterval(() => {
      this.scan().catch((err) => {
        log.error("Scan error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, SCAN_INTERVAL);
  }

  stop(): void {
    this._state = { ...this._state, enabled: false };
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    log.info("Stopped correlated contracts strategy");
  }

  async scan(): Promise<Opportunity[]> {
    const opportunities: Opportunity[] = [];

    try {
      const events = await this.restClient.getNegRiskEvents(50);

      for (const event of events) {
        if (event.markets.length < 2) continue;

        // Get YES prices for each outcome
        const outcomes: CorrelatedContractSignal["outcomes"][number][] = [];

        for (const market of event.markets) {
          const yesToken = market.tokens?.find((t) => t.outcome === "Yes" || t.outcome === "YES");
          if (!yesToken) continue;

          // Try to get live price from CLOB, fall back to Gamma price
          let yesPrice = yesToken.price;
          const livePrice = await this.restClient.getMidpoint(yesToken.token_id);
          if (livePrice !== null) {
            yesPrice = livePrice;
          }

          outcomes.push({
            conditionId: market.condition_id,
            tokenId: yesToken.token_id,
            question: market.question,
            yesPrice,
          });
        }

        if (outcomes.length < 2) continue;

        const prices = outcomes.map((o) => o.yesPrice);
        const total = sumProbabilities(prices);
        const deviation = total - 1.0;

        if (Math.abs(deviation) < MIN_DEVIATION) continue;

        const type = deviation > 0 ? "OVERPRICED" : "UNDERPRICED";

        // Find the most mispriced outcome
        let mostMispriced = outcomes[0];
        if (type === "UNDERPRICED") {
          // For underpriced sum, find the cheapest outcome (most underpriced)
          for (const o of outcomes) {
            if (o.yesPrice < mostMispriced.yesPrice) {
              mostMispriced = o;
            }
          }
        } else {
          // For overpriced sum, find the most expensive (to potentially sell if we hold)
          for (const o of outcomes) {
            if (o.yesPrice > mostMispriced.yesPrice) {
              mostMispriced = o;
            }
          }
        }

        const signal: CorrelatedContractSignal = {
          eventSlug: event.slug,
          eventTitle: event.title,
          outcomes,
          sumYesPrices: total,
          deviation,
          type,
          mostMispriced: {
            conditionId: mostMispriced.conditionId,
            tokenId: mostMispriced.tokenId,
            question: mostMispriced.question,
            price: mostMispriced.yesPrice,
          },
          timestamp: Date.now(),
        };

        log.info("Correlated contract mispricing detected", {
          event: event.title,
          outcomes: outcomes.length,
          sum: total.toFixed(4),
          deviation: (deviation * 100).toFixed(2) + "%",
          type,
          mostMispriced: mostMispriced.question,
        });

        // Only generate buy opportunities (we need to hold tokens to sell)
        if (type === "UNDERPRICED") {
          const opp = this.signalToOpportunity(signal);
          opportunities.push(opp);
          this.onOpportunity?.(opp);
        } else {
          // Log sell opportunities but don't generate trade signals unless we hold
          log.info("Sell opportunity (requires holdings)", {
            event: event.title,
            deviation: (deviation * 100).toFixed(2) + "%",
          });
        }
      }
    } catch (err) {
      log.error("Failed to scan correlated contracts", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this._state = {
      ...this._state,
      lastScan: Date.now(),
      opportunitiesFound: this._state.opportunitiesFound + opportunities.length,
    };

    return opportunities;
  }

  private signalToOpportunity(signal: CorrelatedContractSignal): Opportunity {
    return {
      id: `corr-${signal.eventSlug}-${Date.now()}`,
      strategy: "correlated-contracts",
      timestamp: signal.timestamp,
      description: `${signal.type} event "${signal.eventTitle}" sum=${signal.sumYesPrices.toFixed(4)}, buy ${signal.mostMispriced.question}`,
      expectedSpread: Math.abs(signal.deviation) * 100,
      confidence: Math.min(Math.abs(signal.deviation) / 0.10, 1.0), // 10% deviation = max confidence
      params: {
        tokenId: signal.mostMispriced.tokenId,
        side: "BUY",
        price: signal.mostMispriced.price,
        size: this.config.maxPositionSize,
        orderType: "GTC",
        conditionId: signal.mostMispriced.conditionId,
        negRisk: true,
      },
      metadata: {
        eventSlug: signal.eventSlug,
        eventTitle: signal.eventTitle,
        sumYesPrices: signal.sumYesPrices,
        deviation: signal.deviation,
        outcomesCount: signal.outcomes.length,
      },
    };
  }
}
