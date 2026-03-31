import { createLogger } from "../core/logger.js";
import { fetchWithRetry } from "../utils/retry.js";
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
  tokens: GammaToken[];
  events: GammaEvent[];
}

interface GammaEventResponse {
  slug: string;
  title: string;
  markets: GammaMarket[];
}

export class PolymarketRestClient {
  private readonly clobUrl: string;

  constructor(clobUrl: string) {
    this.clobUrl = clobUrl;
  }

  async getActiveEvents(limit = 50, offset = 0): Promise<GammaEventResponse[]> {
    const url = `${GAMMA_BASE}/events?closed=false&active=true&limit=${limit}&offset=${offset}`;
    log.debug("Fetching active events", { url });

    const resp = await fetchWithRetry(url);
    const data = await resp.json() as GammaEventResponse[];
    log.info("Fetched active events", { count: data.length });
    return data;
  }

  async getActiveMarkets(limit = 100, offset = 0): Promise<PolymarketMarket[]> {
    const url = `${GAMMA_BASE}/markets?active=true&closed=false&limit=${limit}&offset=${offset}`;
    log.debug("Fetching active markets", { url });

    const resp = await fetchWithRetry(url);
    const raw = await resp.json() as GammaMarket[];
    return raw.map((m) => this.mapMarket(m));
  }

  async getCryptoMarkets(): Promise<PolymarketMarket[]> {
    const url = `${GAMMA_BASE}/markets?active=true&closed=false&limit=100&tag=crypto`;
    log.debug("Fetching crypto markets", { url });

    try {
      const resp = await fetchWithRetry(url);
      const raw = await resp.json() as GammaMarket[];
      return raw.map((m) => this.mapMarket(m));
    } catch {
      log.warn("Crypto tag filter failed, fetching all and filtering");
      const all = await this.getActiveMarkets(200);
      return all.filter((m) => this.isCryptoMarket(m));
    }
  }

  async getNegRiskEvents(): Promise<GammaEventResponse[]> {
    const events = await this.getActiveEvents(100);
    return events.filter((e) => e.markets?.some((m) => m.neg_risk));
  }

  async getOrderBook(tokenId: string): Promise<OrderBookSnapshot> {
    const url = `${this.clobUrl}/book?token_id=${tokenId}`;
    log.debug("Fetching order book", { tokenId });

    const resp = await fetchWithRetry(url);
    const raw = await resp.json() as {
      bids: { price: string; size: string }[];
      asks: { price: string; size: string }[];
    };

    const bids: OrderBookLevel[] = (raw.bids ?? []).map((l) => ({
      price: parseFloat(l.price),
      size: parseFloat(l.size),
    }));

    const asks: OrderBookLevel[] = (raw.asks ?? []).map((l) => ({
      price: parseFloat(l.price),
      size: parseFloat(l.size),
    }));

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
    const url = `${this.clobUrl}/midpoint?token_id=${tokenId}`;
    const resp = await fetchWithRetry(url);
    const data = await resp.json() as { mid: string };
    return parseFloat(data.mid);
  }

  async getPrice(tokenId: string, side: "BUY" | "SELL"): Promise<number> {
    const url = `${this.clobUrl}/price?token_id=${tokenId}&side=${side}`;
    const resp = await fetchWithRetry(url);
    const data = await resp.json() as { price: string };
    return parseFloat(data.price);
  }

  private mapMarket(m: GammaMarket): PolymarketMarket {
    const tokens: PolymarketToken[] = (m.tokens ?? []).map((t) => ({
      tokenId: t.token_id,
      outcome: t.outcome.toUpperCase() === "YES" ? "YES" as const : "NO" as const,
      price: t.price,
      winner: t.winner,
    }));

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
      volume: parseFloat(m.volume ?? "0"),
      liquidity: parseFloat(m.liquidity ?? "0"),
      eventSlug: event?.slug ?? "",
      eventTitle: event?.title ?? "",
    };
  }

  private isCryptoMarket(m: PolymarketMarket): boolean {
    const q = m.question.toLowerCase();
    const keywords = ["btc", "bitcoin", "eth", "ethereum", "crypto", "above $", "below $"];
    return keywords.some((k) => q.includes(k));
  }
}
