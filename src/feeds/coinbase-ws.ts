import { WsManager } from "../utils/ws-manager.js";
import { createLogger } from "../core/logger.js";
import type { SpotPrice } from "../core/types.js";

const log = createLogger("coinbase-ws");

interface CoinbaseTickerMsg {
  readonly type: string;
  readonly product_id: string;
  readonly price: string;
  readonly time: string;
}

type PriceCallback = (price: SpotPrice) => void;

export class CoinbaseFeed {
  private readonly ws: WsManager;
  private onPrice: PriceCallback | null = null;

  constructor(url: string) {
    this.ws = new WsManager({ url, name: "coinbase-ws" });

    this.ws.setConnectedHandler(() => {
      this.subscribe();
    });

    this.ws.setMessageHandler((raw: unknown) => {
      try {
        this.handleMessage(raw);
      } catch (err) {
        log.error("Failed to handle message", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  setPriceHandler(handler: PriceCallback): void {
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
    log.info("Subscribing to BTC-USD and ETH-USD ticker");
    this.ws.send({
      type: "subscribe",
      channels: [
        { name: "ticker", product_ids: ["BTC-USD", "ETH-USD"] },
      ],
    });
  }

  private handleMessage(raw: unknown): void {
    const msg = raw as CoinbaseTickerMsg;
    if (!msg || msg.type !== "ticker") return;

    const symbol = this.normalizeSymbol(msg.product_id);
    if (!symbol) return;

    const priceNum = parseFloat(msg.price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      log.warn("Invalid price from Coinbase", { raw: msg.price, symbol });
      return;
    }

    const timestamp = new Date(msg.time).getTime();
    if (!Number.isFinite(timestamp)) {
      log.warn("Invalid timestamp from Coinbase", { raw: msg.time });
      return;
    }

    const price: SpotPrice = {
      symbol,
      price: priceNum,
      timestamp,
      source: "coinbase",
    };

    this.onPrice?.(price);
  }

  private normalizeSymbol(productId: string): string | null {
    if (productId === "BTC-USD") return "BTC";
    if (productId === "ETH-USD") return "ETH";
    return null;
  }
}
