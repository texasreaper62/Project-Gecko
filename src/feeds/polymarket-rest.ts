import { createLogger } from "../core/logger.js";
import { fetchWithRetry } from "../utils/retry.js";
import type { PolymarketMarket, PolymarketToken, OrderBookSnapshot, OrderBookLevel } from "../core/types.js";

const log = createLogger("polymarket-rest");
const GAMMA_BASE = "https://gamma-api.polymarket.com";

interface GammaMarket {
  readonly condition_id: string;
  readonly question_id: string;
  readonly question: string;
  readonly market_slug: string;
  readonly tokens: readonly { token_id: string; outcome: string; price: number; winner: boolean }[];
  readonly active: boolean;
  readonly closed: boolean;
  readonly neg_risk: boolean;
  readonly end_date_iso: string;
  readonly volume_num: number;
  readonly liquidity_num: number;
  readonly event_slug: string;
  readonly event_title?: string;
}

interface GammaEvent {
  readonly slug: string;
  readonly title: string;
  readonly markets: readonly GammaMarket[];
}

export class PolymarketRestClient {
  private readonly clobUrl: string;

  constructor(clobUrl: string) {
    this.clobUrl = clobUrl;
  }

  // Fetch active events from Gamma API
  async getActiveEvents(limit = 50, offset = 0): Promise<GammaEvent[]> {
    const url = `${GAMMA_BASE}/events?closed=false&limit=${limit}&offset=${offset}`;
    try {
      const resp = await fetchWithRetry(url);
      const data = await resp.json() as GammaEvent[];
      log.debug("Fetched events", { count: data.length });
      return data;
    } catch (err) {
      log.error("Failed to fetch events", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // Fetch active markets from Gamma API
  async getActiveMarkets(limit = 100, offset = 0): Promise<PolymarketMarket[]> {
    const url = `${GAMMA_BASE}/markets?active=true&limit=${limit}&offset=${offset}`;
    try {
      const resp = await fetchWithRetry(url);
      const raw = await resp.json() as GammaMarket[];
      return raw.map((m) => this.toPolymarketMarket(m));
    } catch (err) {
      log.error("Failed to fetch markets", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // Search for crypto-related short-duration markets (for temporal arb)
  async getCryptoMarkets(): Promise<PolymarketMarket[]> {
    const url = `${GAMMA_BASE}/markets?active=true&limit=100&tag=crypto`;
    try {
      const resp = await fetchWithRetry(url);
      const raw = await resp.json() as GammaMarket[];
      const markets = raw.map((m) => this.toPolymarketMarket(m));
      log.info("Fetched crypto markets", { count: markets.length });
      return markets;
    } catch (err) {
      log.error("Failed to fetch crypto markets", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // Fetch neg_risk events (multi-outcome, for correlated contracts)
  async getNegRiskEvents(limit = 50): Promise<GammaEvent[]> {
    const events = await this.getActiveEvents(limit);
    const negRiskEvents = events.filter(
      (e) => e.markets.length > 1 && e.markets.some((m) => m.neg_risk),
    );
    log.debug("Found neg risk events", { count: negRiskEvents.length });
    return negRiskEvents;
  }

  // Fetch midpoint price from CLOB
  async getMidpoint(tokenId: string): Promise<number | null> {
    const url = `${this.clobUrl}/midpoint?token_id=${tokenId}`;
    try {
      const resp = await fetchWithRetry(url);
      const data = await resp.json() as { mid: string };
      return parseFloat(data.mid);
    } catch (err) {
      log.warn("Failed to fetch midpoint", { tokenId, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  // Fetch best price from CLOB
  async getPrice(tokenId: string, side: "BUY" | "SELL"): Promise<number | null> {
    const url = `${this.clobUrl}/price?token_id=${tokenId}&side=${side}`;
    try {
      const resp = await fetchWithRetry(url);
      const data = await resp.json() as { price: string };
      return parseFloat(data.price);
    } catch (err) {
      log.warn("Failed to fetch price", { tokenId, side, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  // Fetch full order book from CLOB
  async getOrderBook(tokenId: string): Promise<OrderBookSnapshot | null> {
    const url = `${this.clobUrl}/book?token_id=${tokenId}`;
    try {
      const resp = await fetchWithRetry(url);
      const data = await resp.json() as {
        bids: { price: string; size: string }[];
        asks: { price: string; size: string }[];
      };

      const bids: OrderBookLevel[] = (data.bids || []).map((b) => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size),
      }));
      const asks: OrderBookLevel[] = (data.asks || []).map((a) => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size),
      }));

      const bestBid = bids.length > 0 ? bids[0].price : 0;
      const bestAsk = asks.length > 0 ? asks[0].price : 0;
      const midpoint = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
      const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;

      let depth = 0;
      for (const b of bids) depth += b.price * b.size;
      for (const a of asks) depth += a.price * a.size;

      return {
        tokenId,
        bids,
        asks,
        bestBid,
        bestAsk,
        midpoint,
        spread,
        depth,
        timestamp: Date.now(),
      };
    } catch (err) {
      log.warn("Failed to fetch order book", { tokenId, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private toPolymarketMarket(m: GammaMarket): PolymarketMarket {
    const tokens: PolymarketToken[] = (m.tokens || []).map((t) => ({
      tokenId: t.token_id,
      outcome: t.outcome as "YES" | "NO",
      price: t.price,
      winner: t.winner,
    }));

    return {
      conditionId: m.condition_id,
      questionId: m.question_id,
      question: m.question,
      slug: m.market_slug,
      tokens,
      active: m.active,
      closed: m.closed,
      negRisk: m.neg_risk,
      endDateIso: m.end_date_iso,
      volume: m.volume_num,
      liquidity: m.liquidity_num,
      eventSlug: m.event_slug,
      eventTitle: m.event_title ?? "",
    };
  }
}
