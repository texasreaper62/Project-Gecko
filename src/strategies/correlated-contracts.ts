import { createLogger } from "../core/logger.js";
import type { AppConfig, Opportunity, PolymarketMarket } from "../core/types.js";
import type { PolymarketRestClient } from "../feeds/polymarket-rest.js";
import { generateOpportunityId } from "./strategy-types.js";
import { sumProbabilities } from "../utils/math.js";

const log = createLogger("correlated-contracts");

// How often to scan for mispricing (ms)
const SCAN_INTERVAL = 60_000;
// Minimum deviation from 1.00 to flag an opportunity (percent)
const SUM_DEVIATION_THRESHOLD = 2.0;

interface EventOutcome {
  readonly conditionId: string;
  readonly question: string;
  readonly yesPrice: number;
  readonly yesTokenId: string;
  readonly negRisk: boolean;
}

export class CorrelatedContractsStrategy {
  private readonly config: AppConfig;
  private readonly polyRest: PolymarketRestClient;

  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private onOpportunity: ((opp: Opportunity) => void) | null = null;

  constructor(config: AppConfig, polyRest: PolymarketRestClient) {
    this.config = config;
    this.polyRest = polyRest;
  }

  setOpportunityHandler(handler: (opp: Opportunity) => void): void {
    this.onOpportunity = handler;
  }

  start(): void {
    log.info("Starting correlated contracts strategy");

    // Initial scan
    this.scan().catch((err) => {
      log.error("Initial scan error", { error: err instanceof Error ? err.message : String(err) });
    });

    this.scanTimer = setInterval(() => {
      this.scan().catch((err) => {
        log.error("Scan error", { error: err instanceof Error ? err.message : String(err) });
      });
    }, SCAN_INTERVAL);
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    log.info("Stopped correlated contracts strategy");
  }

  async scan(): Promise<Opportunity[]> {
    const opportunities: Opportunity[] = [];

    try {
      const events = await this.polyRest.getNegRiskEvents();

      for (const event of events) {
        if (!event.markets || event.markets.length < 2) continue;

        const outcomes: EventOutcome[] = [];

        for (const market of event.markets) {
          if (market.closed || !market.active) continue;

          const yesToken = market.tokens?.find(
            (t) => t.outcome.toUpperCase() === "YES"
          );
          if (!yesToken) continue;

          outcomes.push({
            conditionId: market.condition_id,
            question: market.question,
            yesPrice: yesToken.price,
            yesTokenId: yesToken.token_id,
            negRisk: market.neg_risk,
          });
        }

        if (outcomes.length < 2) continue;

        const yesPrices = outcomes.map((o) => o.yesPrice);
        const totalProb = sumProbabilities(yesPrices);
        const deviation = (totalProb - 1.0) * 100; // as percentage

        if (Math.abs(deviation) < SUM_DEVIATION_THRESHOLD) continue;

        log.info("Correlated mispricing detected", {
          event: event.title,
          outcomes: outcomes.length,
          sum: totalProb.toFixed(4),
          deviation: deviation.toFixed(2),
        });

        if (deviation < -SUM_DEVIATION_THRESHOLD) {
          // Prices sum to < 1.0: buy opportunity
          // Find the most underpriced outcome (lowest YES price, likely to be undervalued)
          const sorted = [...outcomes].sort((a, b) => a.yesPrice - b.yesPrice);
          const best = sorted[sorted.length - 1]; // Highest probability but sum < 1 means all are cheap

          // Actually, in an underpriced scenario, we want the outcome we think is most likely
          // to win. We use the highest-priced one as a proxy.
          if (best && best.yesPrice > 0 && best.yesPrice < 1) {
            const opp: Opportunity = {
              id: generateOpportunityId("correlated-contracts"),
              strategy: "correlated-contracts",
              timestamp: Date.now(),
              description: `${event.title}: ${outcomes.length} outcomes sum to ${(totalProb * 100).toFixed(1)}% ` +
                `(expected 100%). Buy opportunity on "${best.question}" at ${(best.yesPrice * 100).toFixed(1)}%`,
              expectedSpread: Math.abs(deviation),
              confidence: Math.min(Math.abs(deviation) / 10, 1),
              params: {
                tokenId: best.yesTokenId,
                side: "BUY",
                price: best.yesPrice,
                size: Math.min(this.config.maxPositionSize, this.config.maxPositionSize),
                orderType: "GTC",
                conditionId: best.conditionId,
                negRisk: best.negRisk,
              },
              metadata: {
                eventTitle: event.title,
                eventSlug: event.slug,
                outcomeCount: outcomes.length,
                totalProbability: totalProb,
                deviation,
                allOutcomes: outcomes.map((o) => ({
                  question: o.question,
                  yesPrice: o.yesPrice,
                })),
              },
            };

            opportunities.push(opp);
            this.onOpportunity?.(opp);
          }
        } else if (deviation > SUM_DEVIATION_THRESHOLD) {
          // Prices sum to > 1.0: sell opportunity
          // Would need to hold tokens to sell; log but skip execution
          log.info("Sell opportunity (requires existing position)", {
            event: event.title,
            sum: totalProb.toFixed(4),
            deviation: deviation.toFixed(2),
          });
        }
      }
    } catch (err) {
      log.error("Scan failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return opportunities;
  }
}
