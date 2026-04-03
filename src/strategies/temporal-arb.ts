import { createLogger } from "../core/logger.js";
import type { AppConfig, Opportunity, PolymarketMarket, PolymarketToken } from "../core/types.js";
import type { FeedAggregator } from "../feeds/feed-aggregator.js";
import type { PolymarketRestClient } from "../feeds/polymarket-rest.js";
import type { PolymarketWsFeed } from "../feeds/polymarket-ws.js";
import { generateOpportunityId } from "./strategy-types.js";
import { priceMomentum } from "../utils/math.js";
import type { SelfTuner } from "./self-tuner.js";
import type { EmpiricalModel } from "./empirical-model.js";
import { fetchWithRetry } from "../utils/retry.js";

const log = createLogger("temporal-arb");

const GAMMA_BASE = "https://gamma-api.polymarket.com";

// Scan every 500ms (these markets move fast)
const SCAN_INTERVAL = 500;
// Refresh active market windows every 30 seconds
const MARKET_REFRESH_INTERVAL = 30_000;
// Minimum seconds until contract expiry to consider trading
const MIN_EXPIRY_SECONDS = 30;
// Minimum price history data points for momentum
const MIN_PRICE_POINTS = 5;
// Cooldown per conditionId to prevent duplicate signals
const OPPORTUNITY_COOLDOWN_MS = 10_000;

// Assets and window sizes to track
const TRACKED_ASSETS = ["btc", "eth", "sol", "xrp"] as const;
const WINDOW_SIZES = [
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
] as const;

type TrackedAsset = typeof TRACKED_ASSETS[number];

// Map asset slug names to spot price symbols
const ASSET_TO_SYMBOL: Record<TrackedAsset, string> = {
  btc: "BTC",
  eth: "ETH",
  sol: "SOL",
  xrp: "XRP",
};

interface ActiveWindow {
  readonly asset: TrackedAsset;
  readonly windowLabel: string;
  readonly windowSeconds: number;
  readonly slug: string;
  readonly openTimestamp: number; // Unix seconds when window opened
  readonly closeTimestamp: number; // Unix seconds when window closes
  market: PolymarketMarket | null;
  upToken: PolymarketToken | null;
  downToken: PolymarketToken | null;
}

export class TemporalArbStrategy {
  private readonly config: AppConfig;
  private readonly aggregator: FeedAggregator;
  private readonly polyRest: PolymarketRestClient;
  private readonly polyWs: PolymarketWsFeed;
  private readonly selfTuner: SelfTuner | null;
  private readonly empiricalModel: EmpiricalModel | null;

  private activeWindows: ActiveWindow[] = [];
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
    empiricalModel?: EmpiricalModel,
  ) {
    this.config = config;
    this.aggregator = aggregator;
    this.polyRest = polyRest;
    this.polyWs = polyWs;
    this.selfTuner = selfTuner ?? null;
    this.empiricalModel = empiricalModel ?? null;
  }

  setOpportunityHandler(handler: (opp: Opportunity) => void): void {
    this.onOpportunity = handler;
  }

  async start(): Promise<void> {
    log.info("Starting temporal arbitrage strategy (Up/Down markets)");
    await this.refreshWindows();

    this.scanTimer = setInterval(() => {
      this.scan().catch((err) => {
        log.error("Scan error", { error: err instanceof Error ? err.message : String(err) });
      });
    }, SCAN_INTERVAL);

    this.refreshTimer = setInterval(() => {
      this.refreshWindows().catch((err) => {
        log.error("Window refresh error", { error: err instanceof Error ? err.message : String(err) });
      });
    }, MARKET_REFRESH_INTERVAL);
  }

  stop(): void {
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    log.info("Stopped temporal arbitrage strategy");
  }

  async scan(): Promise<Opportunity[]> {
    const opportunities: Opportunity[] = [];

    if (!this.aggregator.areFeedsHealthy()) return opportunities;

    for (const window of this.activeWindows) {
      if (!window.upToken || !window.downToken) continue;

      try {
        const opp = this.evaluateWindow(window);
        if (opp) {
          opportunities.push(opp);
          this.onOpportunity?.(opp);
        }
      } catch (err) {
        log.error("Error evaluating window", {
          slug: window.slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return opportunities;
  }

  private evaluateWindow(window: ActiveWindow): Opportunity | null {
    // Dedup cooldown
    const lastSignal = this.recentOpportunities.get(window.slug);
    if (lastSignal && Date.now() - lastSignal < OPPORTUNITY_COOLDOWN_MS) return null;

    const symbol = ASSET_TO_SYMBOL[window.asset];
    if (!symbol) return null;

    // We only have spot data for BTC and ETH from our feeds
    if (symbol !== "BTC" && symbol !== "ETH") return null;

    // Get confirmed spot price
    const spotState = this.aggregator.getConfirmedSpotPrice(symbol);
    if (!spotState || spotState.confirmedPrice === null) return null;

    // Get price history for momentum
    const history = this.aggregator.getSpotPriceHistory(symbol);
    if (history.length < MIN_PRICE_POINTS) return null;
    const first = history[0];
    const last = history[history.length - 1];
    if (last.timestamp - first.timestamp < 100) return null;

    // Check time to expiry
    const timeToExpiry = window.closeTimestamp * 1000 - Date.now();
    if (timeToExpiry < MIN_EXPIRY_SECONDS * 1000) return null;

    // Calculate momentum
    const momentum = priceMomentum(history);
    const currentSpot = spotState.confirmedPrice;

    // Project price at window close
    const projectedPrice = currentSpot + momentum * timeToExpiry;
    const projectedUp = projectedPrice > currentSpot;

    // Get token prices
    const upToken = window.upToken!;
    const downToken = window.downToken!;
    const upPrice = this.aggregator.getTokenPrice(upToken.tokenId) ?? upToken.price;
    const downPrice = this.aggregator.getTokenPrice(downToken.tokenId) ?? downToken.price;

    if (upPrice <= 0 || upPrice >= 1 || downPrice <= 0 || downPrice >= 1) return null;

    // Calculate realized volatility for confidence scaling
    const volatilityScale = this.estimateVolatility(history, currentSpot);
    const momentumStrength = Math.abs(momentum * timeToExpiry) / volatilityScale;

    // Sigmoid to convert momentum strength to directional probability
    const kMultiplier = this.selfTuner?.getKMultiplier() ?? 1.0;
    const k = 2.0 * kMultiplier; // Scale factor for momentum strength
    const sigmoidProb = 1 / (1 + Math.exp(-k * momentumStrength));

    // True probability of "Up" outcome
    const trueUpProbability = projectedUp ? sigmoidProb : (1 - sigmoidProb);

    // Blend with empirical model if available
    const distancePct = Math.abs(projectedPrice - currentSpot) / currentSpot * 100;
    const timeToExpiryMin = timeToExpiry / 60_000;
    const empiricalProb = this.empiricalModel?.getEmpiricalProbability(distancePct, timeToExpiryMin) ?? null;
    const finalUpProb = empiricalProb !== null
      ? (projectedUp ? 0.7 * empiricalProb + 0.3 * trueUpProbability : 1 - (0.7 * empiricalProb + 0.3 * (1 - trueUpProbability)))
      : trueUpProbability;

    // Market's implied probability of Up
    const marketUpProb = upPrice;

    // Calculate edge
    const upEdge = (finalUpProb - marketUpProb) * 100;
    const downEdge = ((1 - finalUpProb) - downPrice) * 100;

    const spreadThreshold = this.selfTuner?.getSpreadThreshold() ?? this.config.minSpreadThreshold;

    // Choose the side with the larger edge
    let edge: number;
    let buyUp: boolean;
    if (upEdge > downEdge) {
      edge = upEdge;
      buyUp = true;
    } else {
      edge = downEdge;
      buyUp = false;
    }

    if (edge < spreadThreshold) return null;

    const targetToken = buyUp ? upToken : downToken;
    const targetPrice = buyUp ? upPrice : downPrice;
    const confidence = Math.min(edge / 20, 1);
    const positionSize = this.config.maxPositionSize * Math.max(confidence, 0.2);

    const opp: Opportunity = {
      id: generateOpportunityId("temporal-arb"),
      strategy: "temporal-arb",
      timestamp: Date.now(),
      description: `${symbol} ${window.windowLabel} ${buyUp ? "UP" : "DOWN"}: ` +
        `spot=$${currentSpot.toFixed(2)}, momentum=${projectedUp ? "+" : "-"}${Math.abs(momentum * 60000).toFixed(2)}/min, ` +
        `market=${(marketUpProb * 100).toFixed(1)}%Up, est=${(finalUpProb * 100).toFixed(1)}%Up, ` +
        `edge=${edge.toFixed(1)}%`,
      expectedSpread: edge,
      confidence,
      params: {
        tokenId: targetToken.tokenId,
        side: "BUY",
        price: targetPrice,
        size: positionSize,
        orderType: "FOK",
        conditionId: window.market?.conditionId ?? "",
        negRisk: false,
      },
      metadata: {
        symbol,
        windowLabel: window.windowLabel,
        spotPrice: currentSpot,
        projectedPrice,
        momentum,
        trueProbability: finalUpProb,
        marketProbability: marketUpProb,
        timeToExpiryMs: timeToExpiry,
        buyUp,
        momentumStrength,
      },
    };

    log.info("Opportunity detected", {
      id: opp.id,
      edge: edge.toFixed(2),
      direction: buyUp ? "UP" : "DOWN",
      window: window.windowLabel,
      asset: symbol,
      slug: window.slug,
    });

    this.recentOpportunities.set(window.slug, Date.now());
    return opp;
  }

  // Build deterministic slugs for currently active windows and fetch their market data
  private async refreshWindows(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const newWindows: ActiveWindow[] = [];

    for (const asset of TRACKED_ASSETS) {
      for (const ws of WINDOW_SIZES) {
        // Current window: the one that's currently open
        const windowOpen = Math.floor(now / ws.seconds) * ws.seconds;
        const windowClose = windowOpen + ws.seconds;

        // Only target if there's enough time left
        if (windowClose - now < MIN_EXPIRY_SECONDS) continue;

        const slug = `${asset}-updown-${ws.label}-${windowOpen}`;

        // Check if we already have this window
        const existing = this.activeWindows.find((w) => w.slug === slug);
        if (existing) {
          newWindows.push(existing);
          continue;
        }

        // Fetch market data for this slug
        const window: ActiveWindow = {
          asset,
          windowLabel: ws.label,
          windowSeconds: ws.seconds,
          slug,
          openTimestamp: windowOpen,
          closeTimestamp: windowClose,
          market: null,
          upToken: null,
          downToken: null,
        };

        try {
          // Step 1: Get conditionId and basic data from Gamma API
          const url = `${GAMMA_BASE}/events?slug=${slug}`;
          const resp = await fetchWithRetry(url);
          const text = await resp.text();
          const events = JSON.parse(text.replace(/([:,\[]\s*)(-?\d{16,})(\s*[,\]\}])/g, '$1"$2"$3')) as {
            markets?: {
              conditionId?: string;
              condition_id?: string;
              question?: string;
              tokens?: { token_id: string; outcome: string; price: number }[];
              clobTokenIds?: string;
              clob_token_ids?: string;
              outcomePrices?: string;
            }[];
          }[];

          const event = events[0];
          const mkt = event?.markets?.[0];
          if (!mkt) {
            newWindows.push(window);
            continue;
          }

          const conditionId = mkt.conditionId ?? mkt.condition_id ?? "";

          // Step 2: Get proper token IDs from CLOB API (returns strings, no truncation)
          let tokens: PolymarketToken[] = [];
          if (conditionId) {
            try {
              const clobUrl = `${this.config.polymarketClobUrl}/markets/${conditionId}`;
              const clobResp = await fetchWithRetry(clobUrl);
              const clobText = await clobResp.text();
              const clobData = JSON.parse(clobText) as {
                tokens?: { token_id: string; outcome: string; price: number }[];
              };

              if (clobData.tokens && clobData.tokens.length > 0) {
                tokens = clobData.tokens.map((t) => ({
                  tokenId: String(t.token_id),
                  outcome: t.outcome?.toLowerCase() === "up" ? "YES" as const : "NO" as const,
                  price: typeof t.price === "number" ? t.price : parseFloat(String(t.price)) || 0,
                  winner: false,
                }));
                log.info("Got CLOB token IDs", {
                  slug,
                  conditionId,
                  tokenCount: tokens.length,
                  upTokenLen: tokens.find((t) => t.outcome === "YES")?.tokenId.length,
                  sample: tokens[0]?.tokenId.slice(0, 40),
                });
              }
            } catch (clobErr) {
              log.debug("CLOB market fetch failed, falling back to Gamma data", {
                slug,
                error: clobErr instanceof Error ? clobErr.message : String(clobErr),
              });
            }
          }

          // Fallback: use Gamma data if CLOB didn't work
          if (tokens.length === 0) {
            if (mkt.clobTokenIds || mkt.clob_token_ids) {
              const ids: string[] = JSON.parse(mkt.clobTokenIds ?? mkt.clob_token_ids ?? "[]");
              let prices = [0.5, 0.5];
              if (mkt.outcomePrices) {
                try { prices = JSON.parse(mkt.outcomePrices).map((p: string) => parseFloat(p) || 0.5); } catch { /* */ }
              }
              if (ids[0]) tokens.push({ tokenId: ids[0], outcome: "YES", price: prices[0], winner: false });
              if (ids[1]) tokens.push({ tokenId: ids[1], outcome: "NO", price: prices[1], winner: false });
            } else if (mkt.tokens && mkt.tokens.length > 0) {
              tokens = mkt.tokens.map((t) => ({
                tokenId: String(t.token_id),
                outcome: t.outcome?.toLowerCase() === "up" ? "YES" as const : "NO" as const,
                price: t.price ?? 0,
                winner: false,
              }));
            }
          }

          // Map Up=YES, Down=NO
          window.upToken = tokens.find((t) => t.outcome === "YES") ?? null;
          window.downToken = tokens.find((t) => t.outcome === "NO") ?? null;
          window.market = {
            conditionId,
            questionId: "",
            question: mkt.question ?? `${asset} Up/Down ${ws.label}`,
            slug,
            tokens,
            active: true,
            closed: false,
            negRisk: false,
            endDateIso: new Date(windowClose * 1000).toISOString(),
            volume: 0,
            liquidity: 0,
            eventSlug: slug,
            eventTitle: `${asset.toUpperCase()} ${ws.label} Up/Down`,
          };

          // Subscribe to WS for real-time prices (require 50+ digit token IDs)
          const tokenIds = tokens.map((t) => t.tokenId).filter((id) => id && id.length >= 50);
          if (tokenIds.length > 0) {
            this.polyWs.subscribeToTokens(tokenIds);
            log.info("Subscribed to WS tokens", { slug, count: tokenIds.length, sampleLen: tokenIds[0].length });
          } else {
            log.warn("Token IDs too short for WS subscription", {
              slug,
              lengths: tokens.map((t) => t.tokenId.length),
            });
          }
        } catch (err) {
          log.debug("Failed to fetch window market", {
            slug,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        newWindows.push(window);
      }
    }

    // Cleanup cooldown map
    const now2 = Date.now();
    for (const [key, ts] of this.recentOpportunities) {
      if (now2 - ts > OPPORTUNITY_COOLDOWN_MS * 2) {
        this.recentOpportunities.delete(key);
      }
    }

    this.activeWindows = newWindows;
    const withTokens = newWindows.filter((w) => w.upToken && w.downToken).length;

    log.info("Refreshed active windows", {
      total: newWindows.length,
      withTokens,
      assets: TRACKED_ASSETS.join(","),
      windowSizes: WINDOW_SIZES.map((w) => w.label).join(","),
    });
  }

  private estimateVolatility(
    history: readonly { price: number; timestamp: number }[],
    currentSpot: number,
  ): number {
    if (history.length < 5) return currentSpot * 0.001;
    const changes: number[] = [];
    for (let i = 1; i < history.length; i++) {
      changes.push(Math.abs(history[i].price - history[i - 1].price));
    }
    const mean = changes.reduce((s, c) => s + c, 0) / changes.length;
    const variance = changes.reduce((s, c) => s + (c - mean) ** 2, 0) / changes.length;
    return Math.max(Math.sqrt(variance), currentSpot * 0.0001);
  }
}
