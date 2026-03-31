import { createLogger } from "../core/logger.js";
import type { SpotPrice, PriceState } from "../core/types.js";
import type { PolymarketPriceUpdate } from "./polymarket-ws.js";

const log = createLogger("feed-aggregator");

// Max age before a price is considered stale (5 seconds)
const STALE_THRESHOLD_MS = 5_000;
// Max divergence between feeds before we distrust (0.5%)
const MAX_FEED_DIVERGENCE = 0.005;

export class FeedAggregator {
  // Spot prices per symbol
  private readonly spotPrices: Map<string, PriceState> = new Map();
  // Polymarket contract prices per tokenId
  private readonly contractPrices: Map<string, { price: number; timestamp: number }> = new Map();
  // Recent spot price history for momentum calculation
  private readonly priceHistory: Map<string, { price: number; timestamp: number }[]> = new Map();
  private readonly maxHistoryLength = 60; // Keep last 60 ticks

  constructor() {
    // Initialize BTC and ETH price states
    for (const symbol of ["BTC", "ETH"]) {
      this.spotPrices.set(symbol, {
        binance: null,
        coinbase: null,
        confirmedPrice: null,
        lastUpdate: 0,
      });
      this.priceHistory.set(symbol, []);
    }
  }

  // Called by Binance/Coinbase feeds
  updateSpotPrice(price: SpotPrice): void {
    const current = this.spotPrices.get(price.symbol);
    if (!current) return;

    const updated: PriceState = {
      ...current,
      [price.source]: price,
      lastUpdate: Date.now(),
      confirmedPrice: this.calculateConfirmedPrice(
        price.source === "binance" ? price : current.binance,
        price.source === "coinbase" ? price : current.coinbase,
      ),
    };

    this.spotPrices.set(price.symbol, updated);

    // Track history for momentum
    if (updated.confirmedPrice !== null) {
      const history = this.priceHistory.get(price.symbol)!;
      history.push({ price: updated.confirmedPrice, timestamp: Date.now() });
      if (history.length > this.maxHistoryLength) {
        history.shift();
      }
    }
  }

  // Called by Polymarket WS feed
  updateContractPrice(update: PolymarketPriceUpdate): void {
    this.contractPrices.set(update.tokenId, {
      price: update.price,
      timestamp: update.timestamp,
    });
  }

  // Get confirmed spot price for a symbol (only if both feeds agree)
  getConfirmedSpotPrice(symbol: string): number | null {
    const state = this.spotPrices.get(symbol);
    if (!state) return null;
    return state.confirmedPrice;
  }

  // Get the latest price from any feed for a symbol
  getLatestSpotPrice(symbol: string): number | null {
    const state = this.spotPrices.get(symbol);
    if (!state) return null;

    // Prefer confirmed, fall back to most recent single feed
    if (state.confirmedPrice !== null) return state.confirmedPrice;

    const binanceAge = state.binance ? Date.now() - state.binance.timestamp : Infinity;
    const coinbaseAge = state.coinbase ? Date.now() - state.coinbase.timestamp : Infinity;

    if (binanceAge < STALE_THRESHOLD_MS && state.binance) return state.binance.price;
    if (coinbaseAge < STALE_THRESHOLD_MS && state.coinbase) return state.coinbase.price;

    return null;
  }

  // Get contract price for a token
  getContractPrice(tokenId: string): number | null {
    const entry = this.contractPrices.get(tokenId);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > STALE_THRESHOLD_MS * 6) return null; // 30s stale
    return entry.price;
  }

  // Get price history for momentum calculations
  getPriceHistory(symbol: string): readonly { price: number; timestamp: number }[] {
    return this.priceHistory.get(symbol) ?? [];
  }

  // Check if both feeds are providing data
  areBothFeedsActive(symbol: string): boolean {
    const state = this.spotPrices.get(symbol);
    if (!state) return false;
    const now = Date.now();
    const binanceFresh = state.binance !== null && (now - state.binance.timestamp) < STALE_THRESHOLD_MS;
    const coinbaseFresh = state.coinbase !== null && (now - state.coinbase.timestamp) < STALE_THRESHOLD_MS;
    return binanceFresh && coinbaseFresh;
  }

  // Get full state for a symbol (for logging/debugging)
  getSpotState(symbol: string): PriceState | null {
    return this.spotPrices.get(symbol) ?? null;
  }

  private calculateConfirmedPrice(
    binance: SpotPrice | null,
    coinbase: SpotPrice | null,
  ): number | null {
    if (!binance || !coinbase) return null;

    const now = Date.now();
    // Both must be fresh
    if (now - binance.timestamp > STALE_THRESHOLD_MS) return null;
    if (now - coinbase.timestamp > STALE_THRESHOLD_MS) return null;

    // Check divergence
    const mid = (binance.price + coinbase.price) / 2;
    if (mid === 0) return null;
    const divergence = Math.abs(binance.price - coinbase.price) / mid;

    if (divergence > MAX_FEED_DIVERGENCE) {
      log.warn("Feed divergence too high", {
        symbol: binance.symbol,
        binancePrice: binance.price,
        coinbasePrice: coinbase.price,
        divergence: (divergence * 100).toFixed(3) + "%",
      });
      return null;
    }

    // Use midpoint of both feeds
    return mid;
  }
}
