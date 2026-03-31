import { WsManager } from "../utils/ws-manager.js";
import { createLogger } from "../core/logger.js";
import type { SpotPrice } from "../core/types.js";

const log = createLogger("coinbase-ws");

interface CoinbaseTickerMsg {
  readonly type: string;
  readonly product_id?: string;
  readonly price?: string;
  readonly time?: string;
}

export class CoinbaseFeed {
  private readonly ws: WsManager;
  private onPrice: ((price: SpotPrice) => void) | null = null;

  constructor(url: string) {
    this.ws = new WsManager({ url, name: "coinbase-ws" });

    this.ws.setMessageHandler((raw: unknown) => {
      this.handleMessage(raw as CoinbaseTickerMsg);
    });

    this.ws.setConnectedHandler(() => {
      log.info("Coinbase feed connected");
      this.subscribe();
    });

    this.ws.setDisconnectedHandler(() => {
      log.warn("Coinbase feed disconnected");
    });
  }

  setPriceHandler(handler: (price: SpotPrice) => void): void {
    this.onPrice = handler;
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

  private subscribe(): void {
    this.ws.send({
      type: "subscribe",
      channels: [
        { name: "ticker", product_ids: ["BTC-USD", "ETH-USD"] },
      ],
    });
    log.info("Subscribed to BTC-USD, ETH-USD ticker");
  }

  private handleMessage(msg: CoinbaseTickerMsg): void {
    try {
      if (msg.type !== "ticker") return;
      if (!msg.product_id || !msg.price || !msg.time) return;

      const symbol = this.normalizeSymbol(msg.product_id);
      if (!symbol) return;

      const price: SpotPrice = {
        symbol,
        price: parseFloat(msg.price),
        timestamp: new Date(msg.time).getTime(),
        source: "coinbase",
      };

      this.onPrice?.(price);
    } catch (err) {
      log.warn("Failed to parse Coinbase message", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private normalizeSymbol(productId: string): string | null {
    if (productId === "BTC-USD") return "BTC";
    if (productId === "ETH-USD") return "ETH";
    return null;
  }
}
