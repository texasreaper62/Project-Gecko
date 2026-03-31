import { WsManager } from "../utils/ws-manager.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("polymarket-ws");

const POLYMARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

interface PriceUpdate {
  readonly tokenId: string;
  readonly price: number;
  readonly timestamp: number;
}

type PriceUpdateCallback = (update: PriceUpdate) => void;

interface WsBookMsg {
  readonly event_type: string;
  readonly asset_id?: string;
  readonly market?: string;
  readonly price?: string;
  readonly timestamp?: string;
  readonly changes?: readonly [string, string, string][];
  readonly bids?: { price: string; size: string }[];
  readonly asks?: { price: string; size: string }[];
}

export class PolymarketWsFeed {
  private readonly ws: WsManager;
  private subscribedTokens: Set<string> = new Set();
  private onPriceUpdate: PriceUpdateCallback | null = null;
  private bestBids: Map<string, number> = new Map();
  private bestAsks: Map<string, number> = new Map();

  constructor() {
    this.ws = new WsManager({
      url: POLYMARKET_WS_URL,
      name: "polymarket-ws",
    });

    this.ws.setConnectedHandler(() => {
      this.resubscribe();
    });

    this.ws.setMessageHandler((raw: unknown) => {
      try {
        this.handleMessage(raw);
      } catch (err) {
        log.error("Failed to handle WS message", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  setPriceUpdateHandler(handler: PriceUpdateCallback): void {
    this.onPriceUpdate = handler;
  }

  start(): void {
    this.ws.connect();
  }

  stop(): void {
    this.ws.close();
  }

  getHealth() {
    return this.ws.getHealth();
  }

  subscribeToToken(tokenId: string): void {
    this.subscribedTokens.add(tokenId);
    if (this.ws.getStatus() === "connected") {
      this.sendSubscribe([tokenId]);
    }
  }

  subscribeToTokens(tokenIds: string[]): void {
    for (const id of tokenIds) {
      this.subscribedTokens.add(id);
    }
    if (this.ws.getStatus() === "connected") {
      this.sendSubscribe(tokenIds);
    }
  }

  unsubscribeFromToken(tokenId: string): void {
    this.subscribedTokens.delete(tokenId);
    this.bestBids.delete(tokenId);
    this.bestAsks.delete(tokenId);
    if (this.ws.getStatus() === "connected") {
      this.ws.send({ type: "unsubscribe", assets_ids: [tokenId] });
    }
  }

  private sendSubscribe(tokenIds: string[]): void {
    if (tokenIds.length === 0) return;
    log.info("Subscribing to tokens", { count: tokenIds.length });
    this.ws.send({ assets_ids: tokenIds, type: "market" });
  }

  private resubscribe(): void {
    const tokens = Array.from(this.subscribedTokens);
    if (tokens.length > 0) {
      log.info("Resubscribing after reconnect", { count: tokens.length });
      this.sendSubscribe(tokens);
    }
  }

  private handleMessage(raw: unknown): void {
    const msg = raw as WsBookMsg;

    if (msg.event_type === "book" || msg.event_type === "price_change") {
      const tokenId = msg.asset_id ?? msg.market;
      if (!tokenId) return;

      if (msg.bids && msg.bids.length > 0) {
        this.bestBids.set(tokenId, parseFloat(msg.bids[0].price));
      }
      if (msg.asks && msg.asks.length > 0) {
        this.bestAsks.set(tokenId, parseFloat(msg.asks[0].price));
      }

      if (msg.changes) {
        for (const [side, price, size] of msg.changes) {
          const p = parseFloat(price);
          const s = parseFloat(size);
          if (side === "buy" && (s === 0 || p > (this.bestBids.get(tokenId) ?? 0))) {
            this.bestBids.set(tokenId, s > 0 ? p : 0);
          }
          if (side === "sell" && (s === 0 || p < (this.bestAsks.get(tokenId) ?? Infinity))) {
            this.bestAsks.set(tokenId, s > 0 ? p : 0);
          }
        }
      }

      const bid = this.bestBids.get(tokenId) ?? 0;
      const ask = this.bestAsks.get(tokenId) ?? 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;

      if (mid > 0) {
        this.onPriceUpdate?.({
          tokenId,
          price: mid,
          timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
        });
      }
    }

    if (msg.event_type === "last_trade_price") {
      const tokenId = msg.asset_id ?? msg.market;
      if (!tokenId || !msg.price) return;

      this.onPriceUpdate?.({
        tokenId,
        price: parseFloat(msg.price),
        timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
      });
    }
  }
}
