import { createLogger } from "../core/logger.js";
import type { AppConfig, Opportunity, PolymarketMarket, PolymarketToken } from "../core/types.js";
import type { FeedAggregator } from "../feeds/feed-aggregator.js";
import type { PolymarketRestClient } from "../feeds/polymarket-rest.js";
import type { PolymarketWsFeed } from "../feeds/polymarket-ws.js";
import { generateOpportunityId } from "./strategy-types.js";
import type { SelfTuner } from "./self-tuner.js";
import type { EmpiricalModel } from "./empirical-model.js";
import { fetchWithRetry } from "../utils/retry.js";

const log = createLogger("temporal-arb");

const GAMMA_BASE = "https://gamma-api.polymarket.com";

// Core timing: scan every 200ms for maximum speed on lag detection
const SCAN_INTERVAL = 200;
// Refresh market windows every 30 seconds
const MARKET_REFRESH_INTERVAL = 30_000;

// LATENCY ARB: minimum price move on Binance/Coinbase to trigger a trade
// The 0x8dxd bot used 3-5% implied probability edge
// A 0.15% spot move in 30 seconds on BTC implies direction with high confidence
const MIN_SPOT_MOVE_PERCENT = 0.15;
// Lookback window for detecting spot price moves (ms)
const SPOT_MOVE_LOOKBACK_MS = 30_000;
// Minimum edge (percentage points) between our estimate and market price to trade
const MIN_EDGE_PERCENT = 3;
// Cooldown per slug to prevent rapid re-entry on same window
const OPPORTUNITY_COOLDOWN_MS = 5_000;

// Kelly Criterion: fraction of bankroll to risk (Quarter Kelly for safety)
const KELLY_FRACTION = 0.25;
// Maximum single position as fraction of total capital
const MAX_POSITION_FRACTION = 0.08;

// Assets and window sizes to track
const TRACKED_ASSETS = ["btc", "eth", "sol", "xrp"] as const;
const WINDOW_SIZES = [
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
] as const;

type TrackedAsset = typeof TRACKED_ASSETS[number];

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
  readonly openTimestamp: number;
  readonly closeTimestamp: number;
  market: PolymarketMarket | null;
  upToken: PolymarketToken | null;
  downToken: PolymarketToken | null;
  openSpotPrice: number | null;
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
    log.info("Starting latency arbitrage strategy");
    await this.refreshWindows();

    // Scan at 200ms for maximum speed - latency arb needs to be fast
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
    log.info("Stopped latency arbitrage strategy");
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

  /**
   * CORE LATENCY ARBITRAGE LOGIC
   *
   * The mechanism:
   * 1. Detect a significant price move on Binance/Coinbase (confirmed by both feeds)
   * 2. Check if Polymarket's token prices still reflect the OLD probability
   * 3. If there's a >3% edge between real probability and market price, BUY immediately
   * 4. Polymarket will reprice within 2-3 seconds, closing the gap
   *
   * We don't predict anything. We react to confirmed price moves faster than the market.
   */
  private evaluateWindow(window: ActiveWindow): Opportunity | null {
    // Cooldown check
    const lastSignal = this.recentOpportunities.get(window.slug);
    if (lastSignal && Date.now() - lastSignal < OPPORTUNITY_COOLDOWN_MS) return null;

    const symbol = ASSET_TO_SYMBOL[window.asset];
    if (!symbol || (symbol !== "BTC" && symbol !== "ETH")) return null;

    // Must have time left in the window (at least 30 seconds)
    const timeToExpiry = window.closeTimestamp * 1000 - Date.now();
    if (timeToExpiry < 30_000) return null;

    // Get CONFIRMED spot price (both Binance and Coinbase must agree)
    const spotState = this.aggregator.getConfirmedSpotPrice(symbol);
    if (!spotState || spotState.confirmedPrice === null) return null;
    const currentSpot = spotState.confirmedPrice;

    // Record opening price for this window
    if (window.openSpotPrice === null) {
      const history = this.aggregator.getSpotPriceHistory(symbol);
      const windowOpenMs = window.openTimestamp * 1000;
      let bestPrice = currentSpot;
      let bestDiff = Infinity;
      for (const h of history) {
        const diff = Math.abs(h.timestamp - windowOpenMs);
        if (diff < bestDiff) { bestDiff = diff; bestPrice = h.price; }
      }
      window.openSpotPrice = bestPrice;
    }

    // STEP 1: Detect a significant spot price move
    // Look at price change over the last 30 seconds
    const history = this.aggregator.getSpotPriceHistory(symbol);
    const now = Date.now();
    const recentPrices = history.filter((h) => now - h.timestamp < SPOT_MOVE_LOOKBACK_MS);
    if (recentPrices.length < 3) return null;

    // Find the biggest move in the lookback window
    const oldestRecent = recentPrices[0].price;
    const spotMovePercent = ((currentSpot - oldestRecent) / oldestRecent) * 100;
    const absSpotMove = Math.abs(spotMovePercent);

    // Need a meaningful move to have a signal
    if (absSpotMove < MIN_SPOT_MOVE_PERCENT) return null;

    // STEP 2: Determine the "true" probability based on the spot move
    // Window delta: is spot above or below the opening price?
    const windowDelta = currentSpot - window.openSpotPrice;
    const isUp = windowDelta > 0;

    // Convert spot move magnitude to implied probability
    // Bigger moves = higher confidence in direction
    // A 0.5% move in 30s on BTC is very strong signal
    let impliedProbUp: number;
    if (absSpotMove > 0.5) {
      impliedProbUp = isUp ? 0.90 : 0.10;
    } else if (absSpotMove > 0.3) {
      impliedProbUp = isUp ? 0.82 : 0.18;
    } else if (absSpotMove > 0.15) {
      impliedProbUp = isUp ? 0.72 : 0.28;
    } else {
      return null; // Move too small
    }

    // STEP 3: Compare to Polymarket's current token prices
    const upToken = window.upToken!;
    const downToken = window.downToken!;
    const marketUpPrice = this.aggregator.getTokenPrice(upToken.tokenId) ?? upToken.price;
    const marketDownPrice = this.aggregator.getTokenPrice(downToken.tokenId) ?? downToken.price;

    if (marketUpPrice <= 0 || marketUpPrice >= 1) return null;

    // STEP 4: Calculate edge
    // Edge = difference between our implied probability and market price
    const upEdge = (impliedProbUp - marketUpPrice) * 100;
    const downEdge = ((1 - impliedProbUp) - marketDownPrice) * 100;

    // Pick the side with the larger edge
    let edge: number;
    let buyUp: boolean;
    let targetToken: PolymarketToken;
    let targetPrice: number;

    if (upEdge > downEdge) {
      edge = upEdge;
      buyUp = true;
      targetToken = upToken;
      targetPrice = marketUpPrice;
    } else {
      edge = downEdge;
      buyUp = false;
      targetToken = downToken;
      targetPrice = marketDownPrice;
    }

    // Need minimum edge to overcome fees and slippage
    if (edge < MIN_EDGE_PERCENT) return null;

    // STEP 5: Position sizing with Quarter Kelly
    // Kelly: f* = (p * b - q) / b where p=win prob, q=lose prob, b=payout odds
    const winProb = buyUp ? impliedProbUp : (1 - impliedProbUp);
    const payoutOdds = (1 - targetPrice) / targetPrice; // How much we win per dollar risked
    const kellyFraction = (winProb * payoutOdds - (1 - winProb)) / payoutOdds;
    const quarterKelly = Math.max(0, kellyFraction * KELLY_FRACTION);

    // Cap at MAX_POSITION_FRACTION of total capital
    const positionFraction = Math.min(quarterKelly, MAX_POSITION_FRACTION);
    const positionSize = Math.min(
      this.config.maxPositionSize * positionFraction / MAX_POSITION_FRACTION,
      this.config.maxPositionSize,
    );

    if (positionSize < 1) return null; // Below minimum

    const opp: Opportunity = {
      id: generateOpportunityId("temporal-arb"),
      strategy: "temporal-arb",
      timestamp: Date.now(),
      description: `${symbol} ${window.windowLabel} LATENCY ARB ${buyUp ? "UP" : "DOWN"}: ` +
        `spot moved ${spotMovePercent > 0 ? "+" : ""}${spotMovePercent.toFixed(3)}% in ${SPOT_MOVE_LOOKBACK_MS / 1000}s, ` +
        `implied=${(impliedProbUp * 100).toFixed(0)}%Up, market=${(marketUpPrice * 100).toFixed(1)}%Up, ` +
        `edge=${edge.toFixed(1)}%, kelly=${(quarterKelly * 100).toFixed(1)}%`,
      expectedSpread: edge,
      confidence: winProb,
      params: {
        tokenId: targetToken.tokenId,
        side: "BUY",
        price: targetPrice,
        size: positionSize,
        // GTC limit order = maker = ZERO FEES
        orderType: "GTC",
        conditionId: window.market?.conditionId ?? "",
        negRisk: false,
      },
      metadata: {
        symbol,
        windowLabel: window.windowLabel,
        spotPrice: currentSpot,
        openSpotPrice: window.openSpotPrice,
        spotMovePercent,
        impliedProbUp,
        marketUpPrice,
        edge,
        kellyFraction: quarterKelly,
        timeToExpiryMs: timeToExpiry,
        buyUp,
        trueProbability: winProb,
        marketProbability: marketUpPrice,
      },
    };

    log.info("LATENCY ARB opportunity", {
      id: opp.id,
      direction: buyUp ? "UP" : "DOWN",
      spotMove: `${spotMovePercent.toFixed(3)}%`,
      edge: `${edge.toFixed(1)}%`,
      kelly: `${(quarterKelly * 100).toFixed(1)}%`,
      size: `$${positionSize.toFixed(2)}`,
      window: window.windowLabel,
      asset: symbol,
    });

    this.recentOpportunities.set(window.slug, Date.now());
    return opp;
  }

  // Build deterministic slugs for currently active windows and fetch their market data
  private async refreshWindows(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const newWindows: ActiveWindow[] = [];

    // Unsubscribe expired window tokens
    const expiredTokenIds: string[] = [];
    for (const w of this.activeWindows) {
      if (w.closeTimestamp <= now) {
        if (w.upToken) expiredTokenIds.push(w.upToken.tokenId);
        if (w.downToken) expiredTokenIds.push(w.downToken.tokenId);
      }
    }
    if (expiredTokenIds.length > 0) {
      this.polyWs.unsubscribeFromTokens(expiredTokenIds);
    }

    for (const asset of TRACKED_ASSETS) {
      for (const ws of WINDOW_SIZES) {
        const windowOpen = Math.floor(now / ws.seconds) * ws.seconds;
        const windowClose = windowOpen + ws.seconds;

        if (windowClose - now < 5) continue; // Skip nearly expired

        const slug = `${asset}-updown-${ws.label}-${windowOpen}`;

        // Reuse existing window if we have it
        const existing = this.activeWindows.find((w) => w.slug === slug);
        if (existing) {
          newWindows.push(existing);
          continue;
        }

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
          openSpotPrice: null,
        };

        try {
          // Get conditionId from Gamma
          const url = `${GAMMA_BASE}/events?slug=${slug}`;
          const resp = await fetchWithRetry(url);
          const text = await resp.text();
          const events = JSON.parse(text.replace(/([:,\[]\s*)(-?\d{16,})(\s*[,\]\}])/g, '$1"$2"$3'));
          const mkt = events[0]?.markets?.[0];

          if (!mkt) { newWindows.push(window); continue; }

          const conditionId = mkt.conditionId ?? mkt.condition_id ?? "";

          // Get proper token IDs from CLOB API
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
              }
            } catch { /* CLOB fetch failed, skip */ }
          }

          // Fallback to Gamma data
          if (tokens.length === 0 && (mkt.clobTokenIds || mkt.clob_token_ids)) {
            try {
              const ids: string[] = JSON.parse(mkt.clobTokenIds ?? mkt.clob_token_ids ?? "[]");
              let prices = [0.5, 0.5];
              if (mkt.outcomePrices) {
                try { prices = JSON.parse(mkt.outcomePrices).map((p: string) => parseFloat(p) || 0.5); } catch { /* */ }
              }
              if (ids[0]) tokens.push({ tokenId: ids[0], outcome: "YES", price: prices[0], winner: false });
              if (ids[1]) tokens.push({ tokenId: ids[1], outcome: "NO", price: prices[1], winner: false });
            } catch { /* parse failed */ }
          }

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
        } catch (err) {
          log.debug("Failed to fetch window", {
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

    // Batch subscribe all new tokens
    const allNewTokenIds: string[] = [];
    for (const w of newWindows) {
      if (w.upToken && w.upToken.tokenId.length >= 50 && !this.polyWs.isSubscribed(w.upToken.tokenId)) {
        allNewTokenIds.push(w.upToken.tokenId);
      }
      if (w.downToken && w.downToken.tokenId.length >= 50 && !this.polyWs.isSubscribed(w.downToken.tokenId)) {
        allNewTokenIds.push(w.downToken.tokenId);
      }
    }
    if (allNewTokenIds.length > 0) {
      this.polyWs.subscribeToTokens(allNewTokenIds);
      log.info("Batch subscribed to WS tokens", { count: allNewTokenIds.length });
    }

    log.info("Refreshed active windows", {
      total: newWindows.length,
      withTokens,
      assets: TRACKED_ASSETS.join(","),
      windowSizes: WINDOW_SIZES.map((w) => w.label).join(","),
    });
  }
}
