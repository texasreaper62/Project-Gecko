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

// Gamma API uses camelCase fields
interface GammaMarket {
  // Gamma uses camelCase, events endpoint uses snake_case
  condition_id?: string;
  conditionId?: string;
  question_id?: string;
  questionId?: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  neg_risk?: boolean;
  negRisk?: boolean;
  end_date_iso?: string;
  endDate?: string;
  volume: string;
  liquidity: string;
  // Token data (may or may not be present)
  tokens?: GammaToken[] | string;
  clob_token_ids?: string;
  clobTokenIds?: string;
  outcomePrices?: string;
  outcomes?: string;
  events?: GammaEvent[];
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
    const text = await resp.text();
    const data = JSON.parse(this.quoteLargeNumbers(text)) as GammaEventResponse[];
    log.info("Fetched active events", { count: data.length });
    return data;
  }

  async getActiveMarkets(limit = 100, offset = 0): Promise<PolymarketMarket[]> {
    await this.gammaMarketsLimiter.acquire();
    const url = `${GAMMA_BASE}/markets?active=true&closed=false&limit=${limit}&offset=${offset}`;
    log.debug("Fetching active markets", { url });

    const resp = await fetchWithRetry(url);
    const text = await resp.text();
    const raw = JSON.parse(this.quoteLargeNumbers(text)) as GammaMarket[];
    return raw.map((m) => this.mapMarket(m));
  }

  async getCryptoMarkets(): Promise<PolymarketMarket[]> {
    await this.gammaMarketsLimiter.acquire();
    const url = `${GAMMA_BASE}/markets?active=true&closed=false&limit=100&tag=crypto`;
    log.debug("Fetching crypto markets", { url });

    try {
      const resp = await fetchWithRetry(url);
      // Fetch as text first and quote large numbers to prevent JSON.parse truncation
      const text = await resp.text();
      const raw = JSON.parse(this.quoteLargeNumbers(text)) as GammaMarket[];

      const mapped = raw.map((m) => this.mapMarket(m));

      // For markets missing token IDs, fetch from CLOB API
      const needsTokens = mapped.filter((m) => m.tokens.length === 0 && m.conditionId);
      if (needsTokens.length > 0) {
        log.info("Fetching token IDs from CLOB API", { count: needsTokens.length });
        await this.enrichWithClobTokens(needsTokens);
      }

      return mapped;
    } catch (err) {
      log.warn("Crypto markets fetch failed, fetching all and filtering", {
        error: err instanceof Error ? err.message : String(err),
      });
      const all = await this.getActiveMarkets(200);
      return all.filter((m) => this.isCryptoMarket(m));
    }
  }

  // Fetch token IDs from CLOB API for markets that don't have them from Gamma
  private async enrichWithClobTokens(markets: PolymarketMarket[]): Promise<void> {
    for (const market of markets) {
      try {
        await this.bookPriceLimiter.acquire();
        const url = `${this.clobUrl}/markets/${market.conditionId}`;
        const resp = await fetchWithRetry(url);
        const text = await resp.text();
        const data = JSON.parse(this.quoteLargeNumbers(text)) as {
          tokens?: { token_id: string; outcome: string; price: number }[];
        };
        if (data.tokens && data.tokens.length > 0) {
          const tokens = data.tokens.map((t) => ({
            tokenId: String(t.token_id),
            outcome: t.outcome?.toUpperCase() === "YES" ? "YES" as const : "NO" as const,
            price: t.price ?? 0,
            winner: false,
          }));
          // Mutate the readonly array via cast since we're enriching
          (market as unknown as { tokens: typeof tokens }).tokens = tokens;
        }
      } catch (err) {
        log.debug("Failed to fetch CLOB market", {
          conditionId: market.conditionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Quote unquoted 16+ digit integers in JSON text to prevent JS Number precision loss.
  private quoteLargeNumbers(text: string): string {
    return text.replace(/([:,\[]\s*)(-?\d{16,})(\s*[,\]\}])/g, '$1"$2"$3');
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
      conditionId: m.condition_id ?? m.conditionId ?? "",
      questionId: m.question_id ?? m.questionId ?? "",
      question: m.question ?? "",
      slug: m.slug ?? "",
      tokens,
      active: m.active ?? true,
      closed: m.closed ?? false,
      negRisk: m.neg_risk ?? m.negRisk ?? false,
      endDateIso: m.end_date_iso ?? m.endDate ?? "",
      volume: parseFloat(String(m.volume ?? "0")) || 0,
      liquidity: parseFloat(String(m.liquidity ?? "0")) || 0,
      eventSlug: event?.slug ?? "",
      eventTitle: event?.title ?? "",
    };
  }

  private parseTokens(m: GammaMarket): PolymarketToken[] {
    // PREFER clob_token_ids: these are JSON strings where token IDs stay as strings,
    // avoiding JavaScript's Number precision loss on 76+ digit integers.
    // The tokens array from JSON.parse often has truncated numeric token IDs.
    // clob_token_ids is a JSON string: '["tokenId1","tokenId2"]' where [0]=YES, [1]=NO
    const clobIds = m.clob_token_ids ?? m.clobTokenIds;
    if (clobIds) {
      try {
        const ids: string[] = JSON.parse(clobIds);
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
        if (result.length > 0) return result;
      } catch {
        log.debug("Failed to parse clob_token_ids", { conditionId: m.condition_id });
      }
    }

    // Fallback: tokens array. WARNING: token_id values may be truncated by JSON.parse
    // if the API returns them as unquoted numbers (76+ digit integers overflow JS Number).
    let rawTokens: GammaToken[] = [];
    if (Array.isArray(m.tokens)) {
      rawTokens = m.tokens;
    } else if (typeof m.tokens === "string" && m.tokens.length > 2) {
      try {
        rawTokens = JSON.parse(m.tokens) as GammaToken[];
      } catch { /* ignore */ }
    }

    if (rawTokens.length > 0) {
      return rawTokens.map((t) => ({
        tokenId: String(t.token_id),
        outcome: t.outcome?.toUpperCase() === "YES" ? "YES" as const : "NO" as const,
        price: t.price ?? 0,
        winner: t.winner ?? false,
      }));
    }

    log.warn("No tokens found for market", {
      conditionId: m.condition_id ?? m.conditionId,
      hasClobTokenIds: !!(m.clob_token_ids ?? m.clobTokenIds),
      hasTokens: !!m.tokens,
    });
    return [];
  }

  private isCryptoMarket(m: PolymarketMarket): boolean {
    const q = m.question.toLowerCase();
    const keywords = ["btc", "bitcoin", "eth", "ethereum", "crypto", "above $", "below $"];
    return keywords.some((k) => q.includes(k));
  }
}
