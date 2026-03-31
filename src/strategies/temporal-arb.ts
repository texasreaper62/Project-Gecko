import { createLogger } from "../core/logger.js";
import type { AppConfig, Opportunity, PolymarketMarket } from "../core/types.js";
import type { FeedAggregator } from "../feeds/feed-aggregator.js";
import type { PolymarketRestClient } from "../feeds/polymarket-rest.js";
import type { PolymarketWsFeed } from "../feeds/polymarket-ws.js";
import { generateOpportunityId } from "./strategy-types.js";
import { priceMomentum, edgePercent } from "../utils/math.js";

const log = createLogger("temporal-arb");

// How often to scan for opportunities (ms)
const SCAN_INTERVAL = 100;
// How often to refresh target markets from Gamma (ms)
const MARKET_REFRESH_INTERVAL = 60_000;
// Minimum seconds until contract expiry to consider trading
const MIN_EXPIRY_SECONDS = 120;
// Number of recent price points needed for momentum
const MIN_PRICE_POINTS = 5;

export class TemporalArbStrategy {
  private readonly config: AppConfig;
  private readonly aggregator: FeedAggregator;
  private readonly polyRest: PolymarketRestClient;
  private readonly polyWs: PolymarketWsFeed;

  private targetMarkets: PolymarketMarket[] = [];
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private onOpportunity: ((opp: Opportunity) => void) | null = null;

  constructor(
    config: AppConfig,
    aggregator: FeedAggregator,
    polyRest: PolymarketRestClient,
    polyWs: PolymarketWsFeed,
  ) {
    this.config = config;
    this.aggregator = aggregator;
    this.polyRest = polyRest;
    this.polyWs = polyWs;
  }

  setOpportunityHandler(handler: (opp: Opportunity) => void): void {
    this.onOpportunity = handler;
  }

  async start(): Promise<void> {
    log.info("Starting temporal arbitrage strategy");
    await this.refreshMarkets();

    this.scanTimer = setInterval(() => {
      this.scan().catch((err) => {
        log.error("Scan error", { error: err instanceof Error ? err.message : String(err) });
      });
    }, SCAN_INTERVAL);

    this.refreshTimer = setInterval(() => {
      this.refreshMarkets().catch((err) => {
        log.error("Market refresh error", { error: err instanceof Error ? err.message : String(err) });
      });
    }, MARKET_REFRESH_INTERVAL);
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    log.info("Stopped temporal arbitrage strategy");
  }

  async scan(): Promise<Opportunity[]> {
    const opportunities: Opportunity[] = [];

    // Only trade when both feeds confirm prices
    if (!this.aggregator.areFeedsHealthy()) {
      return opportunities;
    }

    for (const market of this.targetMarkets) {
      try {
        const opps = this.evaluateMarket(market);
        for (const opp of opps) {
          opportunities.push(opp);
          this.onOpportunity?.(opp);
        }
      } catch (err) {
        log.error("Error evaluating market", {
          market: market.conditionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return opportunities;
  }

  private evaluateMarket(market: PolymarketMarket): Opportunity[] {
    const opportunities: Opportunity[] = [];

    // Determine which crypto asset this market tracks
    const symbol = this.extractSymbol(market.question);
    if (!symbol) return opportunities;

    // Get confirmed spot price
    const spotState = this.aggregator.getConfirmedSpotPrice(symbol);
    if (!spotState || spotState.confirmedPrice === null) return opportunities;

    // Get price history for momentum
    const history = this.aggregator.getSpotPriceHistory(symbol);
    if (history.length < MIN_PRICE_POINTS) return opportunities;

    // Calculate price momentum (per ms)
    const momentum = priceMomentum(history);

    // Extract strike price from market question
    const strike = this.extractStrike(market.question);
    if (strike === null) return opportunities;

    // Check expiry
    const expiryMs = new Date(market.endDateIso).getTime();
    const timeToExpiry = expiryMs - Date.now();
    if (timeToExpiry < MIN_EXPIRY_SECONDS * 1000) return opportunities;

    // Get the YES token
    const yesToken = market.tokens.find((t) => t.outcome === "YES");
    const noToken = market.tokens.find((t) => t.outcome === "NO");
    if (!yesToken || !noToken) return opportunities;

    // Get current market prices from WS feed or fallback to token data
    const yesPrice = this.aggregator.getTokenPrice(yesToken.tokenId) ?? yesToken.price;
    if (yesPrice <= 0 || yesPrice >= 1) return opportunities;

    // Estimate true probability using spot price, momentum, and time to expiry
    const currentSpot = spotState.confirmedPrice;
    const isAboveContract = market.question.toLowerCase().includes("above");
    const projectedPrice = currentSpot + momentum * timeToExpiry;

    // Simple probability estimation based on projected price vs strike
    // The further the projected price is from the strike, the more confident we are
    const priceDelta = isAboveContract
      ? projectedPrice - strike
      : strike - projectedPrice;

    // Use a logistic function to convert price delta to probability
    // k controls steepness, calibrated to asset volatility
    const volatilityScale = currentSpot * 0.001; // ~0.1% as baseline
    const k = 1 / Math.max(volatilityScale, 1);
    const trueProbability = 1 / (1 + Math.exp(-k * priceDelta));

    // Calculate edge
    const marketProbability = yesPrice;
    const edge = edgePercent(trueProbability, marketProbability);

    if (Math.abs(edge) >= this.config.minSpreadThreshold) {
      const buyYes = edge > 0; // True probability > market probability = buy YES
      const targetToken = buyYes ? yesToken : noToken;
      const targetPrice = buyYes ? yesPrice : (1 - yesPrice);

      const opp: Opportunity = {
        id: generateOpportunityId("temporal-arb"),
        strategy: "temporal-arb",
        timestamp: Date.now(),
        description: `${symbol} ${isAboveContract ? "above" : "below"} $${strike}: ` +
          `spot=$${currentSpot.toFixed(2)}, projected=$${projectedPrice.toFixed(2)}, ` +
          `market=${(marketProbability * 100).toFixed(1)}%, est=${(trueProbability * 100).toFixed(1)}%, ` +
          `edge=${edge.toFixed(1)}%`,
        expectedSpread: Math.abs(edge),
        confidence: Math.min(Math.abs(edge) / 20, 1), // Normalize to 0-1
        params: {
          tokenId: targetToken.tokenId,
          side: "BUY",
          price: targetPrice,
          size: Math.min(this.config.maxPositionSize, this.config.maxPositionSize),
          orderType: "FOK",
          conditionId: market.conditionId,
          negRisk: market.negRisk,
        },
        metadata: {
          symbol,
          strike,
          spotPrice: currentSpot,
          projectedPrice,
          momentum,
          trueProbability,
          marketProbability,
          timeToExpiryMs: timeToExpiry,
          buyYes,
        },
      };

      log.info("Opportunity detected", {
        id: opp.id,
        edge: edge.toFixed(2),
        market: market.question,
      });

      opportunities.push(opp);
    }

    return opportunities;
  }

  private async refreshMarkets(): Promise<void> {
    try {
      const markets = await this.polyRest.getCryptoMarkets();

      // Filter for short-duration crypto contracts
      this.targetMarkets = markets.filter((m) => {
        if (m.closed || !m.active) return false;
        const expiry = new Date(m.endDateIso).getTime();
        const timeToExpiry = expiry - Date.now();
        // Only 5-minute and 15-minute contracts (up to ~20 min out)
        if (timeToExpiry <= 0 || timeToExpiry > 20 * 60 * 1000) return false;
        return this.extractSymbol(m.question) !== null;
      });

      // Subscribe to WS feeds for target market tokens
      const tokenIds: string[] = [];
      for (const m of this.targetMarkets) {
        for (const t of m.tokens) {
          tokenIds.push(t.tokenId);
        }
      }
      if (tokenIds.length > 0) {
        this.polyWs.subscribeToTokens(tokenIds);
      }

      log.info("Refreshed target markets", {
        total: markets.length,
        targets: this.targetMarkets.length,
        tokens: tokenIds.length,
      });
    } catch (err) {
      log.error("Failed to refresh markets", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private extractSymbol(question: string): string | null {
    const q = question.toLowerCase();
    if (q.includes("btc") || q.includes("bitcoin")) return "BTC";
    if (q.includes("eth") || q.includes("ethereum")) return "ETH";
    return null;
  }

  private extractStrike(question: string): number | null {
    // Match patterns like "$90,400" or "$90400" or "$90,400.50"
    const match = question.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
    if (!match) return null;
    const cleaned = match[1].replace(/,/g, "");
    const num = parseFloat(cleaned);
    return Number.isNaN(num) ? null : num;
  }
}
