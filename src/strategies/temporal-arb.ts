import { createLogger } from "../core/logger.js";
import type { AppConfig, Opportunity, PolymarketMarket } from "../core/types.js";
import type { FeedAggregator } from "../feeds/feed-aggregator.js";
import type { PolymarketRestClient } from "../feeds/polymarket-rest.js";
import type { PolymarketWsFeed } from "../feeds/polymarket-ws.js";
import { generateOpportunityId } from "./strategy-types.js";
import { priceMomentum, edgePercent } from "../utils/math.js";
import type { SelfTuner } from "./self-tuner.js";

const log = createLogger("temporal-arb");

// How often to scan for opportunities (ms)
const SCAN_INTERVAL = 100;
// How often to refresh target markets from Gamma (ms)
const MARKET_REFRESH_INTERVAL = 60_000;
// Minimum seconds until contract expiry to consider trading
const MIN_EXPIRY_SECONDS = 120;
// Number of recent price points needed for momentum
const MIN_PRICE_POINTS = 5;

// Cooldown per conditionId to prevent duplicate opportunities
const OPPORTUNITY_COOLDOWN_MS = 10_000;

export class TemporalArbStrategy {
  private readonly config: AppConfig;
  private readonly aggregator: FeedAggregator;
  private readonly polyRest: PolymarketRestClient;
  private readonly polyWs: PolymarketWsFeed;

  private readonly selfTuner: SelfTuner | null;

  private targetMarkets: PolymarketMarket[] = [];
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private onOpportunity: ((opp: Opportunity) => void) | null = null;
  private readonly recentOpportunities: Map<string, number> = new Map();

  constructor(
    config: AppConfig,
    aggregator: FeedAggregator,
    polyRest: PolymarketRestClient,
    polyWs: PolymarketWsFeed,
    selfTuner?: SelfTuner,
  ) {
    this.config = config;
    this.aggregator = aggregator;
    this.polyRest = polyRest;
    this.polyWs = polyWs;
    this.selfTuner = selfTuner ?? null;
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

    // Dedup: skip if we recently signaled this market
    const lastSignal = this.recentOpportunities.get(market.conditionId);
    if (lastSignal && Date.now() - lastSignal < OPPORTUNITY_COOLDOWN_MS) {
      return opportunities;
    }

    // Determine which crypto asset this market tracks
    const symbol = this.extractSymbol(market.question);
    if (!symbol) return opportunities;

    // Get confirmed spot price (requires both feeds to agree)
    const spotState = this.aggregator.getConfirmedSpotPrice(symbol);
    if (!spotState || spotState.confirmedPrice === null) return opportunities;

    // Get price history for momentum
    const history = this.aggregator.getSpotPriceHistory(symbol);
    if (history.length < MIN_PRICE_POINTS) return opportunities;

    // Require at least 100ms of price data to avoid zero-dt momentum
    const first = history[0];
    const last = history[history.length - 1];
    if (last.timestamp - first.timestamp < 100) return opportunities;

    // Calculate price momentum (per ms)
    const momentum = priceMomentum(history);

    // Extract strike price and direction from market question
    const strikeInfo = this.extractStrike(market.question);
    if (strikeInfo === null) return opportunities;
    const { strike, isAbove: isAboveContract } = strikeInfo;

    // Check expiry
    const expiryMs = new Date(market.endDateIso).getTime();
    const timeToExpiry = expiryMs - Date.now();
    if (timeToExpiry < MIN_EXPIRY_SECONDS * 1000) return opportunities;

    // Get the YES and NO tokens
    const yesToken = market.tokens.find((t) => t.outcome === "YES");
    const noToken = market.tokens.find((t) => t.outcome === "NO");
    if (!yesToken || !noToken) return opportunities;

    // Get current market prices from WS feed or fallback to token data
    const yesPrice = this.aggregator.getTokenPrice(yesToken.tokenId) ?? yesToken.price;
    if (yesPrice <= 0 || yesPrice >= 1) return opportunities;

    // Estimate true probability using spot price, momentum, and time to expiry
    const currentSpot = spotState.confirmedPrice;
    const projectedPrice = currentSpot + momentum * timeToExpiry;

    // Price delta: positive means the contract outcome is more likely
    const priceDelta = isAboveContract
      ? projectedPrice - strike
      : strike - projectedPrice;

    // Calculate realized volatility from recent price history
    // Standard deviation of returns gives better k calibration than a fixed percentage
    const volatilityScale = this.estimateVolatility(history, currentSpot);
    const baseK = volatilityScale > 0 ? 1 / volatilityScale : 1;
    const kMultiplier = this.selfTuner?.getKMultiplier() ?? 1.0;
    const k = baseK * kMultiplier;
    const trueProbability = 1 / (1 + Math.exp(-k * priceDelta));

    // Calculate edge
    const marketProbability = yesPrice;
    const edge = edgePercent(trueProbability, marketProbability);

    // Use adaptive spread threshold if self-tuner is active
    const spreadThreshold = this.selfTuner?.getSpreadThreshold() ?? this.config.minSpreadThreshold;

    if (Math.abs(edge) >= spreadThreshold) {
      const buyYes = edge > 0; // True probability > market probability = buy YES
      const targetToken = buyYes ? yesToken : noToken;
      const targetPrice = buyYes ? yesPrice : (1 - yesPrice);

      // Confidence-weighted sizing: scale position by edge magnitude
      const confidence = Math.min(Math.abs(edge) / 20, 1);
      const positionSize = this.config.maxPositionSize * Math.max(confidence, 0.2);

      const opp: Opportunity = {
        id: generateOpportunityId("temporal-arb"),
        strategy: "temporal-arb",
        timestamp: Date.now(),
        description: `${symbol} ${isAboveContract ? "above" : "below"} $${strike}: ` +
          `spot=$${currentSpot.toFixed(2)}, projected=$${projectedPrice.toFixed(2)}, ` +
          `market=${(marketProbability * 100).toFixed(1)}%, est=${(trueProbability * 100).toFixed(1)}%, ` +
          `edge=${edge.toFixed(1)}%`,
        expectedSpread: Math.abs(edge),
        confidence,
        params: {
          tokenId: targetToken.tokenId,
          side: "BUY",
          price: targetPrice,
          size: positionSize,
          orderType: "FOK",
          conditionId: market.conditionId,
          negRisk: market.negRisk,
        },
        metadata: {
          symbol,
          strike,
          isAboveContract,
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

      // Mark this market as recently signaled
      this.recentOpportunities.set(market.conditionId, Date.now());

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
        if (m.tokens.length === 0) {
          log.warn("Market has no tokens", { conditionId: m.conditionId, question: m.question.slice(0, 80) });
        }
        for (const t of m.tokens) {
          if (t.tokenId) {
            tokenIds.push(t.tokenId);
          } else {
            log.warn("Token has empty tokenId", { conditionId: m.conditionId, outcome: t.outcome });
          }
        }
      }
      if (tokenIds.length > 0) {
        this.polyWs.subscribeToTokens(tokenIds);
      }

      // Cleanup expired cooldown entries to prevent memory leak
      const now = Date.now();
      for (const [key, ts] of this.recentOpportunities) {
        if (now - ts > OPPORTUNITY_COOLDOWN_MS * 2) {
          this.recentOpportunities.delete(key);
        }
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

  // Estimate price volatility from recent history as standard deviation of price changes.
  // Returns a dollar amount representing typical price movement.
  // Falls back to 0.1% of spot if insufficient data.
  private estimateVolatility(
    history: readonly { price: number; timestamp: number }[],
    currentSpot: number,
  ): number {
    if (history.length < 5) return currentSpot * 0.001;

    // Calculate absolute price changes between consecutive points
    const changes: number[] = [];
    for (let i = 1; i < history.length; i++) {
      changes.push(Math.abs(history[i].price - history[i - 1].price));
    }

    // Standard deviation of changes
    const mean = changes.reduce((s, c) => s + c, 0) / changes.length;
    const variance = changes.reduce((s, c) => s + (c - mean) ** 2, 0) / changes.length;
    const stddev = Math.sqrt(variance);

    // Use stddev as volatility scale, with a floor of 0.01% of spot
    return Math.max(stddev, currentSpot * 0.0001);
  }

  private extractSymbol(question: string): string | null {
    const q = question.toLowerCase();
    if (q.includes("btc") || q.includes("bitcoin")) return "BTC";
    if (q.includes("eth") || q.includes("ethereum")) return "ETH";
    return null;
  }

  private extractStrike(question: string): { strike: number; isAbove: boolean } | null {
    // Try to match "above $X" or "below $X" patterns first for directional context
    const aboveMatch = question.match(/above\s*\$([0-9,]+(?:\.[0-9]+)?)/i);
    const belowMatch = question.match(/below\s*\$([0-9,]+(?:\.[0-9]+)?)/i);

    if (aboveMatch) {
      const num = parseFloat(aboveMatch[1].replace(/,/g, ""));
      return Number.isFinite(num) ? { strike: num, isAbove: true } : null;
    }

    if (belowMatch) {
      const num = parseFloat(belowMatch[1].replace(/,/g, ""));
      return Number.isFinite(num) ? { strike: num, isAbove: false } : null;
    }

    // Fallback: first dollar amount, assume "above" if question contains "above"
    const fallback = question.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
    if (!fallback) return null;
    const num = parseFloat(fallback[1].replace(/,/g, ""));
    if (!Number.isFinite(num)) return null;
    const isAbove = question.toLowerCase().includes("above");
    return { strike: num, isAbove };
  }
}
