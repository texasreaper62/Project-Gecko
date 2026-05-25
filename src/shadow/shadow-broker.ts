// Shadow broker: an in-memory broker that satisfies the Broker interface
// without ever touching a real venue.
//
// Used by the shadow harness to replay historical bars through the live
// pipeline (strategies, confluence, brain, router) and observe what trades
// would have fired. No real orders, no auth, no network risk.
//
// "Fills" are simulated immediately at the requested limit price (or last
// price if MARKET). The shadow broker emits a FILLED order status on the
// next getOrderStatus call so the fill watcher hydrates the position.

import { createLogger } from "../core/logger.js";
import type {
  AccountSnapshot,
  Bar,
} from "../core/types.js";
import type {
  Broker,
  BrokerBracketRequest,
  BrokerBracketResult,
  BrokerHealthStatus,
  BrokerOpenOrder,
  BrokerOrderRequest,
  BrokerOrderStatus,
  BrokerPositionSnapshot,
  BrokerStreamHandler,
  BrokerSubmitResult,
  HistoricalBarsQuery,
  NormalizedOptionChain,
  NormalizedTick,
  OptionChainQuery,
} from "../brokers/broker.js";

const log = createLogger("shadow-broker");

interface ShadowOrder {
  readonly orderId: string;
  readonly req: BrokerOrderRequest;
  readonly placedAt: number;
  status: BrokerOrderStatus;
}

export interface ShadowBrokerOptions {
  readonly startingEquity: number;
  // The replay engine pushes ticks through this broker via emitTick().
  // Strategies subscribe to symbols; we filter ticks by subscription set.
}

export class ShadowBroker implements Broker {
  readonly name = "schwab" as const;        // pretend to be schwab so existing wiring works
  readonly orderLatencyTargetMs = 0;        // instantaneous in shadow

  private equity: number;
  private cashBalance: number;
  private streamHandler: BrokerStreamHandler | null = null;
  private readonly equitySubs: Set<string> = new Set();
  private readonly optionSubs: Set<string> = new Set();
  private readonly orders: Map<string, ShadowOrder> = new Map();
  private orderCounter = 0;
  // Last seen price per symbol (for MARKET fills).
  private readonly lastPrice: Map<string, number> = new Map();

  constructor(opts: ShadowBrokerOptions) {
    this.equity = opts.startingEquity;
    this.cashBalance = opts.startingEquity;
  }

  // Lifecycle (no-op for shadow).
  async start(): Promise<void> {
    log.info("Shadow broker started", { equity: this.equity });
  }
  stop(): void { /* no-op */ }

  // Account: bookkeeping driven by realized P&L from fills.
  async getAccountSnapshot(): Promise<AccountSnapshot> {
    return {
      cashBalance: this.cashBalance,
      buyingPower: this.cashBalance * 4,         // pretend 4x BP
      dayTradeBuyingPower: this.cashBalance * 4,
      equity: this.equity,
      dayTradeCount: 0,
      timestamp: Date.now(),
    };
  }

  // Orders: instant simulated fill.
  // - LIMIT orders fill at the limit price (assumes price touched it, which
  //   is why the strategy submitted the order in the first place).
  // - MARKET orders fill at the last seen price.
  // - For close orders fired by position-monitor on stop/take touches, the
  //   monitor passes the touched price as the limit so we get realistic fills
  //   instead of riding to the last tick.
  async placeOrder(req: BrokerOrderRequest): Promise<BrokerSubmitResult> {
    this.orderCounter++;
    const orderId = `shadow-${this.orderCounter}-${Date.now()}`;
    const sym = req.instrument.assetClass === "equity"
      ? req.instrument.symbol
      : req.instrument.osiSymbol;
    const fillPrice = req.limitPrice ?? this.lastPrice.get(sym) ?? 0;
    if (fillPrice <= 0) {
      log.warn("Shadow order rejected: no fill price", { sym, orderId });
      this.orders.set(orderId, {
        orderId, req, placedAt: Date.now(),
        status: { orderId, status: "REJECTED", filledQuantity: 0, avgPrice: 0 },
      });
      return { orderId };
    }

    const isOption = req.instrument.assetClass === "option";
    const multiplier = isOption ? 100 : 1;
    const dollarCost = fillPrice * req.quantity * multiplier;
    // Equity buys reduce cash; sells increase. Options open reduces, close
    // increases.
    const sideKind = isBuy(req.side) ? -1 : +1;
    this.cashBalance += sideKind * dollarCost;

    this.orders.set(orderId, {
      orderId, req, placedAt: Date.now(),
      status: {
        orderId,
        status: "FILLED",
        filledQuantity: req.quantity,
        avgPrice: fillPrice,
      },
    });

    log.debug("Shadow fill", {
      orderId, sym, side: req.side, qty: req.quantity, fillPrice, dollarCost,
    });
    return { orderId };
  }

  // Shadow doesn't need a real OCA — there's no live broker holding the
  // stop. Just place the entry and pretend the stop/target sit alongside.
  // The shadow harness's position monitor handles stop/target evaluation
  // against replayed bars in the simulator.
  async placeBracket(req: BrokerBracketRequest): Promise<BrokerBracketResult> {
    const entry = await this.placeOrder(req.entry);
    const stopId = `shadow-stop-${this.orderCounter}-${Date.now()}`;
    const tpId = `shadow-tp-${this.orderCounter}-${Date.now()}`;
    return {
      entryOrderId: entry.orderId,
      stopOrderId: stopId,
      takeProfitOrderId: tpId,
    };
  }

  async getPositions(): Promise<readonly BrokerPositionSnapshot[]> {
    return [];     // shadow starts each run fresh
  }

  async getOpenOrders(): Promise<readonly BrokerOpenOrder[]> {
    return [];
  }

  async healthCheck(): Promise<BrokerHealthStatus> {
    return { ok: true, authenticated: true, connected: true, message: "shadow broker" };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const o = this.orders.get(orderId);
    if (o) o.status = { ...o.status, status: "CANCELED" };
  }

  async getOrderStatus(orderId: string): Promise<BrokerOrderStatus | null> {
    return this.orders.get(orderId)?.status ?? null;
  }

  // Market data: shadow doesn't fetch live; the replay engine pushes via emitTick.
  async getOptionChain(_q: OptionChainQuery): Promise<NormalizedOptionChain | null> {
    return null;
  }
  async getHistoricalBars(_q: HistoricalBarsQuery): Promise<readonly Bar[]> {
    return [];
  }
  async getQuote(symbol: string): Promise<NormalizedTick | null> {
    const p = this.lastPrice.get(symbol);
    if (!p) return null;
    return { symbol, last: p, timestamp: Date.now() };
  }

  // Streaming: handler set by orchestrator, ticks pushed by the replay engine.
  setStreamHandler(h: BrokerStreamHandler): void {
    this.streamHandler = h;
  }
  async subscribeEquities(symbols: readonly string[]): Promise<void> {
    for (const s of symbols) this.equitySubs.add(s.toUpperCase());
    log.debug("Shadow equity subs", { count: this.equitySubs.size });
  }
  async subscribeOptions(symbols: readonly string[]): Promise<void> {
    for (const s of symbols) this.optionSubs.add(s);
    log.debug("Shadow option subs", { count: this.optionSubs.size });
  }
  async subscribeAccountActivity(): Promise<void> { /* no-op */ }

  // ----- Shadow-only API -----

  // Inject a tick into the stream. Replay engine drives this.
  emitTick(kind: "equity-tick" | "option-tick", ticks: readonly NormalizedTick[]): void {
    // Only emit ticks for symbols we've subscribed to.
    const subs = kind === "equity-tick" ? this.equitySubs : this.optionSubs;
    const filtered: NormalizedTick[] = [];
    for (const t of ticks) {
      const key = kind === "equity-tick" ? t.symbol.toUpperCase() : t.symbol;
      if (!subs.has(key)) continue;
      this.lastPrice.set(key, t.last);
      filtered.push(t);
    }
    if (filtered.length > 0 && this.streamHandler) {
      this.streamHandler(kind, filtered);
    }
  }

  // Stats for the harness end-of-run report.
  getStats(): { orders: number; fills: number; rejects: number; cash: number; equity: number } {
    let fills = 0, rejects = 0;
    for (const o of this.orders.values()) {
      if (o.status.status === "FILLED") fills++;
      else if (o.status.status === "REJECTED") rejects++;
    }
    return { orders: this.orders.size, fills, rejects, cash: this.cashBalance, equity: this.equity };
  }

  getAllOrders(): readonly ShadowOrder[] {
    return Array.from(this.orders.values());
  }
}

function isBuy(side: BrokerOrderRequest["side"]): boolean {
  return side === "BUY" || side === "BUY_TO_OPEN" || side === "BUY_TO_CLOSE";
}
