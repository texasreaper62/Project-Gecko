import { WsManager } from "../utils/ws-manager.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("polymarket-ws");

const POLYMARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

interface PolymarketWsMessage {
  readonly event_type?: string;
  readonly asset_id?: string;
  readonly market?: string;
  readonly price?: string;
  readonly timestamp?: string;
  readonly changes?: readonly { price: string; size: string; side: string }[];
}

export interface PolymarketPriceUpdate {
  readonly tokenId: string;
  readonly price: number;
  readonly timestamp: number;
}

export interface PolymarketBookUpdate {
  readonly tokenId: string;
  readonly changes: readonly { price: number; size: number; side: "BUY" | "SELL" }[];
  readonly timestamp: number;
}

export class PolymarketFeed {
  private readonly ws: WsManager;
  private subscribedTokens: Set<string> = new Set();
  private onPriceUpdate: ((update: PolymarketPriceUpdate) => void) | null = null;
  private onBookUpdate: ((update: PolymarketBookUpdate) => void) | null = null;

  constructor() {
    this.ws = new WsManager({
      url: POLYMARKET_WS_URL,
      name: "polymarket-ws",
    });

    this.ws.setMessageHandler((raw: unknown) => {
      this.handleMessage(raw as PolymarketWsMessage);
    });

    this.ws.setConnectedHandler(() => {
      log.info("Polymarket WebSocket connected");
      // Re-subscribe to all tokens on reconnect
      if (this.subscribedTokens.size > 0) {
        this.resubscribeAll();
      }
    });

    this.ws.setDisconnectedHandler(() => {
      log.warn("Polymarket WebSocket disconnected");
    });
  }

  setPriceHandler(handler: (update: PolymarketPriceUpdate) => void): void {
    this.onPriceUpdate = handler;
  }

  setBookHandler(handler: (update: PolymarketBookUpdate) => void): void {
    this.onBookUpdate = handler;
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

  subscribeToMarket(tokenId: string): void {
    this.subscribedTokens.add(tokenId);
    if (this.ws.getStatus() === "connected") {
      this.sendSubscription([tokenId]);
    }
  }

  subscribeToMarkets(tokenIds: string[]): void {
    for (const id of tokenIds) {
      this.subscribedTokens.add(id);
    }
    if (this.ws.getStatus() === "connected") {
      this.sendSubscription(tokenIds);
    }
  }

  unsubscribeFromMarket(tokenId: string): void {
    this.subscribedTokens.delete(tokenId);
    if (this.ws.getStatus() === "connected") {
      this.ws.send({
        type: "unsubscribe",
        assets_ids: [tokenId],
      });
    }
  }

  private sendSubscription(tokenIds: string[]): void {
    this.ws.send({
      type: "subscribe",
      assets_ids: tokenIds,
    });
    log.info("Subscribed to tokens", { count: tokenIds.length });
  }

  private resubscribeAll(): void {
    const ids = Array.from(this.subscribedTokens);
    if (ids.length > 0) {
      this.sendSubscription(ids);
      log.info("Re-subscribed to all tokens after reconnect", { count: ids.length });
    }
  }

  private handleMessage(msg: PolymarketWsMessage): void {
    try {
      const tokenId = msg.asset_id ?? msg.market;
      if (!tokenId) return;

      // Price update
      if (msg.price) {
        this.onPriceUpdate?.({
          tokenId,
          price: parseFloat(msg.price),
          timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
        });
      }

      // Order book delta
      if (msg.changes && msg.changes.length > 0) {
        const changes = msg.changes.map((c) => ({
          price: parseFloat(c.price),
          size: parseFloat(c.size),
          side: c.side.toUpperCase() as "BUY" | "SELL",
        }));
        this.onBookUpdate?.({
          tokenId,
          changes,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      log.warn("Failed to parse Polymarket WS message", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
