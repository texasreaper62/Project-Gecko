import { WsManager } from "../utils/ws-manager.js";
import { createLogger } from "../core/logger.js";
import type { SpotPrice } from "../core/types.js";

const log = createLogger("binance-ws");

interface BinanceTradeMsg {
  readonly e: string;
  readonly s: string;
  readonly p: string;
  readonly q: string;
  readonly T: number;
  readonly m: boolean;
}

interface BinanceCombinedMsg {
  readonly stream: string;
  readonly data: BinanceTradeMsg;
}

type PriceCallback = (price: SpotPrice) => void;

export class BinanceFeed {
  private readonly ws: WsManager;
  private onPrice: PriceCallback | null = null;

  constructor(url: string) {
    this.ws = new WsManager({ url, name: "binance-ws" });

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

  private handleMessage(raw: unknown): void {
    const msg = raw as BinanceCombinedMsg;
    const trade: BinanceTradeMsg = msg.data ?? (raw as BinanceTradeMsg);

    if (trade.e !== "trade") return;

    const symbol = this.normalizeSymbol(trade.s);
    if (!symbol) return;

    const price: SpotPrice = {
      symbol,
      price: parseFloat(trade.p),
      timestamp: trade.T,
      source: "binance",
    };

    this.onPrice?.(price);
  }

  private normalizeSymbol(raw: string): string | null {
    const upper = raw.toUpperCase();
    if (upper === "BTCUSDT") return "BTC";
    if (upper === "ETHUSDT") return "ETH";
    return null;
  }
}
