import { WsManager } from "../utils/ws-manager.js";
import { createLogger } from "../core/logger.js";
import type { SpotPrice } from "../core/types.js";

const log = createLogger("binance-ws");

interface BinanceTradeMsg {
  readonly stream?: string;
  readonly data?: {
    readonly e: string;
    readonly s: string;
    readonly p: string;
    readonly T: number;
  };
  // Direct format (non-combined stream)
  readonly e?: string;
  readonly s?: string;
  readonly p?: string;
  readonly T?: number;
}

export class BinanceFeed {
  private readonly ws: WsManager;
  private onPrice: ((price: SpotPrice) => void) | null = null;

  constructor(url: string) {
    this.ws = new WsManager({ url, name: "binance-ws" });

    this.ws.setMessageHandler((raw: unknown) => {
      this.handleMessage(raw as BinanceTradeMsg);
    });

    this.ws.setConnectedHandler(() => {
      log.info("Binance feed connected");
    });

    this.ws.setDisconnectedHandler(() => {
      log.warn("Binance feed disconnected");
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

  private handleMessage(msg: BinanceTradeMsg): void {
    try {
      // Combined stream format: { stream: "btcusdt@trade", data: {...} }
      const trade = msg.data ?? msg;
      const eventType = trade.e ?? msg.e;
      if (eventType !== "trade") return;

      const rawSymbol = trade.s ?? msg.s;
      const rawPrice = trade.p ?? msg.p;
      const rawTime = trade.T ?? msg.T;

      if (!rawSymbol || !rawPrice || !rawTime) return;

      const symbol = this.normalizeSymbol(rawSymbol);
      if (!symbol) return;

      const price: SpotPrice = {
        symbol,
        price: parseFloat(rawPrice),
        timestamp: rawTime,
        source: "binance",
      };

      this.onPrice?.(price);
    } catch (err) {
      log.warn("Failed to parse Binance message", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private normalizeSymbol(raw: string): string | null {
    const upper = raw.toUpperCase();
    if (upper === "BTCUSDT") return "BTC";
    if (upper === "ETHUSDT") return "ETH";
    return null;
  }
}
