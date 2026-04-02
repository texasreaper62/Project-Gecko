import { createLogger } from "../core/logger.js";
import { fetchWithRetry } from "../utils/retry.js";
import {
  createBookPriceLimiter,
  createGammaEventsLimiter,
  createGammaMarketsLimiter,
  type RateLimiter,
} from "../utils/rate-limiter.js";
import type { PolymarketMarket, PolymarketToken, OrderBookSnapshot, OrderBookLevel } from "../core/types.js";

const log = createLogger("polymarket-rest");

const GAMMA_BASE = "https://gamma-api.polymarket.com";

interface GammaToken {
  token_id: string;
  outcome: string;
  price: number;
  winner: boolean;
}

interface GammaEvent {
  slug: string;
  title: string;
}

interface GammaMarket {
  condition_id: string;
  question_id: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  neg_risk: boolean;
  end_date_iso: string;
  volume: string;
  liquidity: string;
  // Gamma API may return tokens as array, JSON string, or not at all
  tokens: GammaToken[] | string;
  // Alternative fields the API might use
  clob_token_ids?: string;
  clobTokenIds?: string;
  outcomePrices?: string;
  events: GammaEvent[];
}

interface GammaEventResponse {
  slug: string;
  title: string;
  markets: GammaMarket[];
}

export class PolymarketRestClient {
  private readonly clobUrl: string;
  private readonly bookPriceLimiter: RateLimiter;
  private readonly gammaEventsLimiter: RateLimiter;
  private readonly gammaMarketsLimiter: RateLimiter;

  constructor(clobUrl: string) {
    this.bookPriceLimiter = createBookPriceLimiter();
    this.gammaEventsLimiter = createGammaEventsLimiter();
    this.gammaMarketsLimiter = createGammaMarketsLimiter();
    this.clobUrl = clobUrl;
  }

  async getActiveEvents(limit = 50, offset = 0): Promise<GammaEventResponse[]> {
    await this.gammaEventsLimiter.acquire();
    const url = `${GAMMA_BASE}/events?closed=false&active=true&limit=${limit}&offset=${offset}`;
    log.debug("Fetching active events", { url });

    const resp = await fetchWithRetry(url);
    const data = await resp.json() as GammaEventResponse[];
    log.info("Fetched active events", { count: data.length });
    return data;
  }

  async getActiveMarkets(limit = 100, offset = 0): Promise<PolymarketMarket[]> {
    await this.gammaMarketsLimiter.acquire();
    const url = `${GAMMA_BASE}/markets?active=true&closed=false&limit=${limit}&offset=${offset}`;
    log.debug("Fetching active markets", { url });

    const resp = await fetchWithRetry(url);
    const raw = await resp.json() as GammaMarket[];
    return raw.map((m) => this.mapMarket(m));
  }

  async getCryptoMarkets(): Promise<PolymarketMarket[]> {
    await this.gammaMarketsLimiter.acquire();
    const url = `${GAMMA_BASE}/markets?active=true&closed=false&limit=100&tag=crypto`;
    log.debug("Fetching crypto markets", { url });

    try {
      const resp = await fetchWithRetry(url);
      const raw = await resp.json() as GammaMarket[];
      log.debug("Crypto markets raw sample", {
        count: raw.length,
        firstTokens: raw[0]?.tokens?.length ?? 0,
        firstQuestion: raw[0]?.question?.slice(0, 80),
        sampleKeys: raw[0] ? Object.keys(raw[0]).join(",") : "empty",
      });
      return raw.map((m) => this.mapMarket(m));
    } catch {
      log.warn("Crypto tag filter failed, fetching all and filtering");
      const all = await this.getActiveMarkets(200);
      return all.filter((m) => this.isCryptoMarket(m));
    }
  }

  async getNegRiskEvents(): Promise<{ slug: string; title: string; markets: PolymarketMarket[] }[]> {
    const events = await this.getActiveEvents(100);
    return events
      .filter((e) => e.markets?.some((m) => m.neg_risk))
      .map((e) => ({
        slug: e.slug,
        title: e.title,
        markets: (e.markets ?? []).map((m) => this.mapMarket(m)),
      }));
  }

  async getOrderBook(tokenId: string): Promise<OrderBookSnapshot> {
    await this.bookPriceLimiter.acquire();
    const url = `${this.clobUrl}/book?token_id=${tokenId}`;
    log.debug("Fetching order book", { tokenId });

    const resp = await fetchWithRetry(url);
    const raw = await resp.json() as {
      bids: { price: string; size: string }[];
      asks: { price: string; size: string }[];
    };

    const bids: OrderBookLevel[] = (raw.bids ?? [])
      .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0);

    const asks: OrderBookLevel[] = (raw.asks ?? [])
      .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0);

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 0;
    const midpoint = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
    const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;

    let depth = 0;
    for (const b of bids) depth += b.price * b.size;
    for (const a of asks) depth += a.price * a.size;

    return { tokenId, bids, asks, bestBid, bestAsk, midpoint, spread, depth, timestamp: Date.now() };
  }

  async getMidpoint(tokenId: string): Promise<number> {
    await this.bookPriceLimiter.acquire();
    const url = `${this.clobUrl}/midpoint?token_id=${tokenId}`;
    const resp = await fetchWithRetry(url);
    const data = await resp.json() as { mid: string };
    const mid = parseFloat(data.mid);
    if (!Number.isFinite(mid)) {
      throw new Error(`Invalid midpoint for ${tokenId}: ${data.mid}`);
    }
    return mid;
  }

  async getPrice(tokenId: string, side: "BUY" | "SELL"): Promise<number> {
    await this.bookPriceLimiter.acquire();
    const url = `${this.clobUrl}/price?token_id=${tokenId}&side=${side}`;
    const resp = await fetchWithRetry(url);
    const data = await resp.json() as { price: string };
    const price = parseFloat(data.price);
    if (!Number.isFinite(price)) {
      throw new Error(`Invalid price for ${tokenId} ${side}: ${data.price}`);
    }
    return price;
  }

  private mapMarket(m: GammaMarket): PolymarketMarket {
    const tokens = this.parseTokens(m);
    const event = m.events?.[0];

    return {
      conditionId: m.condition_id,
      questionId: m.question_id,
      question: m.question,
      slug: m.slug,
      tokens,
      active: m.active,
      closed: m.closed,
      negRisk: m.neg_risk,
      endDateIso: m.end_date_iso,
      volume: parseFloat(m.volume ?? "0") || 0,
      liquidity: parseFloat(m.liquidity ?? "0") || 0,
      eventSlug: event?.slug ?? "",
      eventTitle: event?.title ?? "",
    };
  }

  private parseTokens(m: GammaMarket): PolymarketToken[] {
    // Case 1: tokens is already an array of objects
    let rawTokens: GammaToken[] = [];

    if (Array.isArray(m.tokens)) {
      rawTokens = m.tokens;
    } else if (typeof m.tokens === "string" && m.tokens.length > 2) {
      // Case 2: tokens is a JSON string
      try {
        rawTokens = JSON.parse(m.tokens) as GammaToken[];
      } catch {
        log.debug("Failed to parse tokens JSON string", { conditionId: m.condition_id });
      }
    }

    if (rawTokens.length > 0) {
      return rawTokens.map((t) => ({
        tokenId: t.token_id,
        outcome: t.outcome.toUpperCase() === "YES" ? "YES" as const : "NO" as const,
        price: t.price,
        winner: t.winner,
      }));
    }

    // Case 3: tokens not available, try clob_token_ids field
    // Gamma API returns clob_token_ids as a JSON string: '["tokenId1","tokenId2"]'
    // where [0] = YES, [1] = NO
    const clobIds = m.clob_token_ids ?? m.clobTokenIds;
    if (clobIds) {
      try {
        const ids: string[] = JSON.parse(clobIds);
        // Parse outcome prices if available: '["0.55","0.45"]'
        let prices: number[] = [0, 0];
        if (m.outcomePrices) {
          try {
            const parsed: string[] = JSON.parse(m.outcomePrices);
            prices = parsed.map((p) => parseFloat(p) || 0);
          } catch { /* ignore */ }
        }

        const result: PolymarketToken[] = [];
        if (ids[0]) {
          result.push({ tokenId: ids[0], outcome: "YES", price: prices[0] ?? 0, winner: false });
        }
        if (ids[1]) {
          result.push({ tokenId: ids[1], outcome: "NO", price: prices[1] ?? 0, winner: false });
        }
        return result;
      } catch {
        log.debug("Failed to parse clob_token_ids", { conditionId: m.condition_id });
      }
    }

    return [];
  }

  private isCryptoMarket(m: PolymarketMarket): boolean {
    const q = m.question.toLowerCase();
    const keywords = ["btc", "bitcoin", "eth", "ethereum", "crypto", "above $", "below $"];
    return keywords.some((k) => q.includes(k));
  }
}
