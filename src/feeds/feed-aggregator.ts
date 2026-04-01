import { createLogger } from "../core/logger.js";
import type { SpotPrice, PriceState } from "../core/types.js";
import type { BinanceFeed } from "./binance-ws.js";
import type { CoinbaseFeed } from "./coinbase-ws.js";
import type { PolymarketWsFeed } from "./polymarket-ws.js";

const log = createLogger("feed-aggregator");

const STALE_THRESHOLD = 5_000;
const MAX_DIVERGENCE_PERCENT = 0.5;
const FEED_DISCONNECT_LIMIT = 30_000;
// Cleanup stale token entries every 5 minutes
const CLEANUP_INTERVAL = 300_000;
// Token entries older than 1 hour are stale
const TOKEN_STALE_THRESHOLD = 3_600_000;

interface PriceEntry {
  price: number;
  timestamp: number;
}

export class FeedAggregator {
  private readonly binancePrices: Map<string, PriceEntry> = new Map();
  private readonly coinbasePrices: Map<string, PriceEntry> = new Map();
  private readonly confirmedSpot: Map<string, PriceState> = new Map();
  private readonly tokenPrices: Map<string, PriceEntry> = new Map();
  private readonly priceHistory: Map<string, { price: number; timestamp: number }[]> = new Map();
  private readonly MAX_HISTORY = 60;
  private readonly feedLastSeen: Map<string, number> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    binance: BinanceFeed,
    coinbase: CoinbaseFeed,
    polymarketWs: PolymarketWsFeed,
  ) {
    binance.setPriceHandler((p) => this.handleSpotPrice(p));
    coinbase.setPriceHandler((p) => this.handleSpotPrice(p));
    polymarketWs.setPriceUpdateHandler((u) => this.handleTokenPrice(u.tokenId, u.price, u.timestamp));

    // Periodic cleanup of stale entries
    this.cleanupTimer = setInterval(() => this.cleanupStaleEntries(), CLEANUP_INTERVAL);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  getConfirmedSpotPrice(symbol: string): PriceState | null {
    return this.confirmedSpot.get(symbol) ?? null;
  }

  getTokenPrice(tokenId: string): number | null {
    const entry = this.tokenPrices.get(tokenId);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > STALE_THRESHOLD) return null;
    return entry.price;
  }

  getSpotPriceHistory(symbol: string): readonly { price: number; timestamp: number }[] {
    return this.priceHistory.get(symbol) ?? [];
  }

  areFeedsHealthy(): boolean {
    const now = Date.now();
    const binanceLast = this.feedLastSeen.get("binance-ws");
    const coinbaseLast = this.feedLastSeen.get("coinbase-ws");
    const polyLast = this.feedLastSeen.get("polymarket-ws");

    if (!binanceLast || now - binanceLast > FEED_DISCONNECT_LIMIT) return false;
    if (!coinbaseLast || now - coinbaseLast > FEED_DISCONNECT_LIMIT) return false;
    // Polymarket WS is only required if we have subscribed tokens
    if (this.tokenPrices.size > 0 && (!polyLast || now - polyLast > FEED_DISCONNECT_LIMIT)) return false;
    return true;
  }

  private handleSpotPrice(price: SpotPrice): void {
    const entry: PriceEntry = { price: price.price, timestamp: price.timestamp };

    if (price.source === "binance") {
      this.binancePrices.set(price.symbol, entry);
    } else {
      this.coinbasePrices.set(price.symbol, entry);
    }

    this.feedLastSeen.set(`${price.source}-ws`, Date.now());
    this.updateConfirmedPrice(price.symbol);
  }

  private handleTokenPrice(tokenId: string, price: number, timestamp: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    this.tokenPrices.set(tokenId, { price, timestamp });
    this.feedLastSeen.set("polymarket-ws", Date.now());
  }

  private updateConfirmedPrice(symbol: string): void {
    const binance = this.binancePrices.get(symbol);
    const coinbase = this.coinbasePrices.get(symbol);
    const now = Date.now();

    const binanceSpot: SpotPrice | null = binance && (now - binance.timestamp < STALE_THRESHOLD)
      ? { symbol, price: binance.price, timestamp: binance.timestamp, source: "binance" }
      : null;

    const coinbaseSpot: SpotPrice | null = coinbase && (now - coinbase.timestamp < STALE_THRESHOLD)
      ? { symbol, price: coinbase.price, timestamp: coinbase.timestamp, source: "coinbase" }
      : null;

    let confirmed: number | null = null;

    if (binanceSpot && coinbaseSpot) {
      const mid = (binanceSpot.price + coinbaseSpot.price) / 2;
      if (mid <= 0) {
        log.warn("Invalid mid price", { binance: binanceSpot.price, coinbase: coinbaseSpot.price });
      } else {
        const divergence = Math.abs(binanceSpot.price - coinbaseSpot.price) / mid * 100;

        if (divergence <= MAX_DIVERGENCE_PERCENT) {
          confirmed = mid;
        } else {
          log.warn("Feed divergence too high", {
            symbol,
            binance: binanceSpot.price,
            coinbase: coinbaseSpot.price,
            divergence: divergence.toFixed(3),
          });
        }
      }
    }

    const state: PriceState = {
      binance: binanceSpot,
      coinbase: coinbaseSpot,
      confirmedPrice: confirmed,
      lastUpdate: now,
    };

    this.confirmedSpot.set(symbol, state);

    if (confirmed !== null) {
      const history = this.priceHistory.get(symbol) ?? [];
      history.push({ price: confirmed, timestamp: now });
      if (history.length > this.MAX_HISTORY) {
        history.shift();
      }
      this.priceHistory.set(symbol, history);
    }
  }

  private cleanupStaleEntries(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [tokenId, entry] of this.tokenPrices) {
      if (now - entry.timestamp > TOKEN_STALE_THRESHOLD) {
        this.tokenPrices.delete(tokenId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log.debug("Cleaned stale token prices", { removed: cleaned, remaining: this.tokenPrices.size });
    }
  }
}
