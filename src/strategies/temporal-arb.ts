import { createLogger } from "../core/logger.js";
import { priceMomentum, edgePercent } from "../utils/math.js";
import { nowIso } from "../utils/time.js";
import { FeedAggregator } from "../feeds/feed-aggregator.js";
import { PolymarketRestClient } from "../feeds/polymarket-rest.js";
import type { AppConfig, Opportunity, StrategyState, PolymarketMarket } from "../core/types.js";
import type { TemporalArbSignal } from "./strategy-types.js";

const log = createLogger("temporal-arb");

// How often to scan for crypto markets (every 5 minutes)
const MARKET_REFRESH_INTERVAL = 5 * 60_000;
// How often to check for opportunities
const SCAN_INTERVAL = 100; // 100ms per the spec

export class TemporalArbStrategy {
  readonly name = "temporal-arb" as const;
  private readonly config: AppConfig;
  private readonly aggregator: FeedAggregator;
  private readonly restClient: PolymarketRestClient;

  private targetMarkets: PolymarketMarket[] = [];
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastMarketRefresh = 0;

  private _state: StrategyState = {
    enabled: false,
    lastScan: 0,
    opportunitiesFound: 0,
    tradesExecuted: 0,
  };

  private onOpportunity: ((opp: Opportunity) => void) | null = null;

  constructor(config: AppConfig, aggregator: FeedAggregator, restClient: PolymarketRestClient) {
    this.config = config;
    this.aggregator = aggregator;
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
    log.info("Starting temporal arb strategy");

    // Initial market refresh
    this.refreshMarkets().catch((err) => {
      log.error("Failed initial market refresh", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Periodic market refresh
    this.refreshTimer = setInterval(() => {
      this.refreshMarkets().catch((err) => {
        log.error("Failed market refresh", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, MARKET_REFRESH_INTERVAL);

    // High-frequency scan for opportunities
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
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    log.info("Stopped temporal arb strategy");
  }

  async scan(): Promise<Opportunity[]> {
    const opportunities: Opportunity[] = [];

    for (const market of this.targetMarkets) {
      if (!market.active || market.closed) continue;

      // Determine which crypto this market references
      const symbol = this.detectCryptoSymbol(market.question);
      if (!symbol) continue;

      // Require both feeds active
      if (!this.aggregator.areBothFeedsActive(symbol)) continue;

      const confirmedSpot = this.aggregator.getConfirmedSpotPrice(symbol);
      if (confirmedSpot === null) continue;

      // Get momentum
      const history = this.aggregator.getPriceHistory(symbol);
      const momentum = priceMomentum(history);

      // Check each token (YES and NO)
      for (const token of market.tokens) {
        const contractPrice = this.aggregator.getContractPrice(token.tokenId);
        if (contractPrice === null) continue;

        // Estimate true probability from spot price and momentum
        const trueProb = this.estimateTrueProbability(market, confirmedSpot, momentum);
        if (trueProb === null) continue;

        const marketProb = contractPrice;
        const edge = edgePercent(trueProb, marketProb);

        // Only act on edges above threshold
        if (Math.abs(edge) < this.config.minSpreadThreshold) continue;

        const signal: TemporalArbSignal = {
          market: market.question,
          conditionId: market.conditionId,
          tokenId: token.tokenId,
          spotPrice: confirmedSpot,
          contractPrice,
          estimatedTrueProb: trueProb,
          marketProb,
          edgePercent: edge,
          direction: edge > 0 ? "BUY_YES" : "BUY_NO",
          spotMomentum: momentum,
          confidence: this.calculateConfidence(Math.abs(edge), history.length),
          timestamp: Date.now(),
        };

        const opp = this.signalToOpportunity(signal, market);
        opportunities.push(opp);

        log.info("Temporal arb opportunity detected", {
          market: market.question,
          edge: edge.toFixed(2) + "%",
          direction: signal.direction,
          spotPrice: confirmedSpot,
          contractPrice,
          trueProb: trueProb.toFixed(4),
        });

        this.onOpportunity?.(opp);
      }
    }

    this._state = {
      ...this._state,
      lastScan: Date.now(),
      opportunitiesFound: this._state.opportunitiesFound + opportunities.length,
    };

    return opportunities;
  }

  private async refreshMarkets(): Promise<void> {
    log.info("Refreshing crypto target markets");
    const markets = await this.restClient.getCryptoMarkets();

    // Filter for short-duration crypto prediction markets
    this.targetMarkets = markets.filter((m) => {
      if (!m.active || m.closed) return false;
      const question = m.question.toLowerCase();
      // Look for short-duration crypto price markets
      const hasCrypto = question.includes("btc") || question.includes("bitcoin") ||
                        question.includes("eth") || question.includes("ethereum");
      const hasTimeframe = question.includes("minute") || question.includes("min") ||
                           question.includes("5m") || question.includes("15m") ||
                           question.includes("hour");
      const hasPriceLevel = question.includes("above") || question.includes("below") ||
                            question.includes("over") || question.includes("under");
      return hasCrypto && (hasTimeframe || hasPriceLevel);
    });

    log.info("Target markets refreshed", { count: this.targetMarkets.length });
    this.lastMarketRefresh = Date.now();
  }

  // Estimate true probability based on spot price, strike price, and momentum
  private estimateTrueProbability(
    market: PolymarketMarket,
    spotPrice: number,
    momentum: number,
  ): number | null {
    // Extract strike price and direction from question
    const parsed = this.parseMarketQuestion(market.question);
    if (!parsed) return null;

    const { strikePrice, direction, durationMinutes } = parsed;

    // Project future price using momentum
    const projectedPrice = spotPrice + (momentum * durationMinutes * 60_000);

    // Simple probability estimate: how far is projected price from strike
    // Using a logistic function centered on the strike price
    const diff = direction === "above"
      ? projectedPrice - strikePrice
      : strikePrice - projectedPrice;

    // Normalize by a reasonable volatility estimate (0.1% of price per minute for BTC)
    const volPerMinute = spotPrice * 0.001;
    const zScore = diff / (volPerMinute * Math.sqrt(durationMinutes));

    // Logistic function: 1 / (1 + e^(-z))
    const prob = 1 / (1 + Math.exp(-zScore));

    return prob;
  }

  private parseMarketQuestion(question: string): {
    strikePrice: number;
    direction: "above" | "below";
    durationMinutes: number;
  } | null {
    const lower = question.toLowerCase();

    // Extract direction
    let direction: "above" | "below";
    if (lower.includes("above") || lower.includes("over")) {
      direction = "above";
    } else if (lower.includes("below") || lower.includes("under")) {
      direction = "below";
    } else {
      return null;
    }

    // Extract price (look for $ followed by numbers with optional comma/decimal)
    const priceMatch = question.match(/\$?([\d,]+(?:\.\d+)?)/);
    if (!priceMatch) return null;
    const strikePrice = parseFloat(priceMatch[1].replace(/,/g, ""));
    if (isNaN(strikePrice) || strikePrice <= 0) return null;

    // Extract duration
    let durationMinutes = 15; // default
    if (lower.includes("5 min") || lower.includes("5m")) {
      durationMinutes = 5;
    } else if (lower.includes("15 min") || lower.includes("15m")) {
      durationMinutes = 15;
    } else if (lower.includes("1 hour") || lower.includes("1h")) {
      durationMinutes = 60;
    }

    return { strikePrice, direction, durationMinutes };
  }

  private calculateConfidence(absEdge: number, historyLength: number): number {
    // Higher edge = higher confidence (capped)
    let conf = Math.min(absEdge / 20, 0.8);
    // More history data = more confident in momentum estimate
    if (historyLength < 10) conf *= 0.5;
    else if (historyLength < 30) conf *= 0.75;
    return Math.min(conf, 1.0);
  }

  private signalToOpportunity(signal: TemporalArbSignal, market: PolymarketMarket): Opportunity {
    // Determine which token to buy
    const yesToken = market.tokens.find((t) => t.outcome === "YES");
    const noToken = market.tokens.find((t) => t.outcome === "NO");
    const buyYes = signal.direction === "BUY_YES";
    const targetToken = buyYes ? yesToken : noToken;

    return {
      id: `temp-arb-${market.conditionId}-${Date.now()}`,
      strategy: "temporal-arb",
      timestamp: signal.timestamp,
      description: `${signal.direction} on "${market.question}" | edge: ${signal.edgePercent.toFixed(2)}%`,
      expectedSpread: Math.abs(signal.edgePercent),
      confidence: signal.confidence,
      params: {
        tokenId: targetToken?.tokenId ?? signal.tokenId,
        side: "BUY",
        price: signal.contractPrice,
        size: this.config.maxPositionSize,
        orderType: "FAK",
        conditionId: market.conditionId,
        negRisk: market.negRisk,
      },
      metadata: {
        spotPrice: signal.spotPrice,
        contractPrice: signal.contractPrice,
        estimatedTrueProb: signal.estimatedTrueProb,
        marketProb: signal.marketProb,
        momentum: signal.spotMomentum,
      },
    };
  }

  private detectCryptoSymbol(question: string): string | null {
    const lower = question.toLowerCase();
    if (lower.includes("btc") || lower.includes("bitcoin")) return "BTC";
    if (lower.includes("eth") || lower.includes("ethereum")) return "ETH";
    return null;
  }
}
