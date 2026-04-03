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

const POLYMARKET_PING_INTERVAL = 50_000; // 50 seconds, per Polymarket docs

export class PolymarketWsFeed {
  private readonly ws: WsManager;
  private subscribedTokens: Set<string> = new Set();
  private onPriceUpdate: PriceUpdateCallback | null = null;
  private bestBids: Map<string, number> = new Map();
  private bestAsks: Map<string, number> = new Map();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.ws = new WsManager({
      url: POLYMARKET_WS_URL,
      name: "polymarket-ws",
    });

    this.ws.setConnectedHandler(() => {
      this.startApplicationPing();
      this.resubscribe();
    });

    this.ws.setDisconnectedHandler(() => {
      this.stopApplicationPing();
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
    this.stopApplicationPing();
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
      this.ws.send({
        type: "market",
        markets: [],
        assets_ids: [tokenId],
        initial_dump: false,
      });
    }
  }

  private startApplicationPing(): void {
    this.stopApplicationPing();
    this.pingTimer = setInterval(() => {
      this.ws.sendRaw("PING");
    }, POLYMARKET_PING_INTERVAL);
  }

  private stopApplicationPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private sendSubscribe(tokenIds: string[]): void {
    if (tokenIds.length === 0) return;
    const valid = tokenIds.filter((id) => id && id.length > 10);
    if (valid.length === 0) {
      log.warn("No valid token IDs to subscribe", { raw: tokenIds.slice(0, 3) });
      return;
    }
    log.info("Subscribing to tokens", {
      count: valid.length,
      firstIdFull: valid[0],
      firstIdLen: valid[0]?.length,
    });
    this.ws.send({
      type: "market",
      markets: [],
      assets_ids: valid,
      initial_dump: true,
    });
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
        const bidPrice = parseFloat(msg.bids[0].price);
        if (Number.isFinite(bidPrice) && bidPrice > 0) {
          this.bestBids.set(tokenId, bidPrice);
        }
      }
      if (msg.asks && msg.asks.length > 0) {
        const askPrice = parseFloat(msg.asks[0].price);
        if (Number.isFinite(askPrice) && askPrice > 0) {
          this.bestAsks.set(tokenId, askPrice);
        }
      }

      if (msg.changes && Array.isArray(msg.changes)) {
        for (const change of msg.changes) {
          if (!Array.isArray(change) || change.length < 3) continue;
          const [side, price, size] = change;
          const p = parseFloat(price);
          const s = parseFloat(size);
          if (!Number.isFinite(p) || !Number.isFinite(s)) continue;

          if (side === "buy") {
            if (s === 0 && this.bestBids.get(tokenId) === p) {
              this.bestBids.delete(tokenId);
            } else if (s > 0 && p > (this.bestBids.get(tokenId) ?? 0)) {
              this.bestBids.set(tokenId, p);
            }
          }
          if (side === "sell") {
            if (s === 0 && this.bestAsks.get(tokenId) === p) {
              this.bestAsks.delete(tokenId);
            } else if (s > 0 && p < (this.bestAsks.get(tokenId) ?? Infinity)) {
              this.bestAsks.set(tokenId, p);
            }
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

      const lastPrice = parseFloat(msg.price);
      if (!Number.isFinite(lastPrice) || lastPrice <= 0) return;

      this.onPriceUpdate?.({
        tokenId,
        price: lastPrice,
        timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
      });
    }
  }
}
