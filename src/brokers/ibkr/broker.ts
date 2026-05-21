// IBKR adapter that satisfies the broker-agnostic Broker interface.
//
// Maps the bot's symbol-centric model to IBKR's conid-centric one:
//   - Ticker -> conid lookup via /iserver/secdef/search, cached
//   - OSI option symbol -> resolved via underlying + expiry + strike + right
//   - Subscribes by conid on the WebSocket, dispatches ticks back keyed by
//     original symbol so strategy code stays unaware.

import { createLogger } from "../../core/logger.js";
import type {
  AccountSnapshot,
  Bar,
} from "../../core/types.js";
import type {
  Broker,
  BrokerOrderRequest,
  BrokerOrderStatus,
  BrokerStreamHandler,
  BrokerSubmitResult,
  HistoricalBarsQuery,
  NormalizedOptionChain,
  NormalizedTick,
  OptionChainQuery,
} from "../broker.js";
import type { IbkrAuth } from "./auth.js";
import type { IbkrRest } from "./rest.js";
import type { IbkrStream } from "./stream.js";
import type { IbkrOrderRequest } from "./types.js";

const log = createLogger("ibkr-broker");

const TICK_FIELDS = {
  LAST: "31",
  BID: "84",
  ASK: "86",
  ASK_SIZE: "85",
  BID_SIZE: "88",
  VOLUME: "87",
  CHANGE_PCT: "83",
} as const;

export class IbkrBroker implements Broker {
  readonly name = "ibkr" as const;
  readonly orderLatencyTargetMs = 100;

  private accountId = "";
  private handler: BrokerStreamHandler | null = null;
  private readonly conidCache: Map<string, number> = new Map();
  // Reverse map so incoming ticks (keyed by conid) can be relabeled to ticker.
  private readonly conidToSymbol: Map<number, string> = new Map();

  constructor(
    private readonly auth: IbkrAuth,
    private readonly rest: IbkrRest,
    private readonly stream: IbkrStream,
  ) {}

  async start(): Promise<void> {
    await this.auth.start();
    const accounts = await this.rest.getAccounts();
    if (accounts.length === 0) throw new Error("IBKR returned no accounts");
    this.accountId = accounts[0].accountId;
    await this.rest.selectAccount(this.accountId);
    log.info("IBKR broker started", { accountId: this.accountId });

    this.stream.setHandler((topic, msg) => this.dispatchStream(topic, msg));
    await this.stream.start();
  }

  stop(): void {
    this.stream.stop();
    this.auth.stop();
  }

  async getAccountSnapshot(): Promise<AccountSnapshot> {
    const summary = await this.rest.getPortfolioSummary(this.accountId);
    return {
      cashBalance: summary.cashbalance?.amount ?? 0,
      buyingPower: summary.buyingpower?.amount ?? 0,
      dayTradeBuyingPower: summary.buyingpower?.amount ?? 0,
      equity: summary.netliquidation?.amount ?? summary.equitywithloanvalue?.amount ?? 0,
      dayTradeCount: 0,           // IBKR doesn't expose this directly; would need PDT calc
      timestamp: Date.now(),
    };
  }

  async placeOrder(req: BrokerOrderRequest): Promise<BrokerSubmitResult> {
    const conid = await this.resolveConid(req.instrument);
    const ibkrReq: IbkrOrderRequest = {
      acctId: this.accountId,
      conid,
      orderType: mapOrderType(req.orderType),
      side: mapSide(req.side),
      tif: req.tif,
      quantity: req.quantity,
      price: req.limitPrice,
      auxPrice: req.stopPrice,
      useAdaptive: true,         // IBKR adaptive algo for better fills
    };
    const placed = await this.rest.placeOrder(this.accountId, ibkrReq);
    return { orderId: placed.order_id, raw: placed };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.rest.cancelOrder(this.accountId, orderId);
  }

  async getOrderStatus(orderId: string): Promise<BrokerOrderStatus | null> {
    const order = await this.rest.getOrderStatus(orderId);
    if (!order) return null;
    return {
      orderId,
      status: mapOrderStatus(order.status),
      filledQuantity: order.filledQuantity ?? 0,
      avgPrice: order.avgPrice ? Number(order.avgPrice) : 0,
    };
  }

  async getOptionChain(_q: OptionChainQuery): Promise<NormalizedOptionChain | null> {
    // Option chain on IBKR requires: resolve underlying conid -> get
    // available strikes/months from /iserver/secdef/strikes -> resolve each
    // contract -> request snapshots in batches. That's a non-trivial walk.
    // Stubbed for now; will fill in when we need Engine B on IBKR.
    log.warn("IBKR option chain query not yet implemented");
    return null;
  }

  async getHistoricalBars(q: HistoricalBarsQuery): Promise<readonly Bar[]> {
    const conid = await this.resolveEquityConidCached(q.symbol);
    const period = q.lookback;
    const bar = q.frequency === "1min" ? "1min" : q.frequency === "5min" ? "5min" : q.frequency === "15min" ? "15min" : q.frequency === "1h" ? "1h" : "1d";
    const resp = await this.rest.getHistorical({ conid, period, bar, outsideRth: q.extendedHours });
    return resp.data.map((b) => ({
      symbol: q.symbol.toUpperCase(),
      timestamp: b.t,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
  }

  async getQuote(symbol: string): Promise<NormalizedTick | null> {
    const conid = await this.resolveEquityConidCached(symbol);
    const rows = await this.rest.getSnapshot([conid]);
    const r = rows[0];
    if (!r) return null;
    return tickFromSnapshot(symbol, r);
  }

  setStreamHandler(h: BrokerStreamHandler): void {
    this.handler = h;
  }

  async subscribeEquities(symbols: readonly string[]): Promise<void> {
    for (const sym of symbols) {
      const conid = await this.resolveEquityConidCached(sym);
      this.conidToSymbol.set(conid, sym.toUpperCase());
      this.stream.subscribeEquity(conid);
    }
  }

  async subscribeOptions(_osiSymbols: readonly string[]): Promise<void> {
    log.warn("IBKR option subscription not yet wired (need OSI -> conid resolver)");
  }

  async subscribeAccountActivity(): Promise<void> {
    this.stream.subscribeLiveOrders();
  }

  // ----- Internals -----

  private async resolveConid(instrument: BrokerOrderRequest["instrument"]): Promise<number> {
    if (instrument.assetClass === "equity") {
      return this.resolveEquityConidCached(instrument.symbol);
    }
    // Option: need underlying conid + month + strike + right.
    // Deferred; option order routing on IBKR coming next.
    throw new Error("IBKR option order routing not yet implemented");
  }

  private async resolveEquityConidCached(symbol: string): Promise<number> {
    const key = symbol.toUpperCase();
    const cached = this.conidCache.get(key);
    if (cached !== undefined) return cached;
    const conid = await this.rest.resolveEquityConid(key);
    if (conid === null) throw new Error(`IBKR could not resolve conid for ${key}`);
    this.conidCache.set(key, conid);
    return conid;
  }

  private dispatchStream(topic: string, msg: Record<string, unknown>): void {
    if (!this.handler) return;
    if (topic.startsWith("smd+")) {
      const conid = Number(topic.slice(4));
      const symbol = this.conidToSymbol.get(conid);
      if (!symbol) return;
      const tick = tickFromSnapshot(symbol, msg);
      if (tick) {
        const kind = symbol.length > 10 ? "option-tick" : "equity-tick";
        this.handler(kind, [tick]);
      }
    } else if (topic === "sor") {
      this.handler("account-activity", []);
    }
  }
}

function tickFromSnapshot(symbol: string, fields: Record<string, unknown>): NormalizedTick | null {
  const last = num(fields[TICK_FIELDS.LAST]);
  if (last === null || last <= 0) return null;
  return {
    symbol,
    last,
    bid: num(fields[TICK_FIELDS.BID]) ?? undefined,
    ask: num(fields[TICK_FIELDS.ASK]) ?? undefined,
    bidSize: num(fields[TICK_FIELDS.BID_SIZE]) ?? undefined,
    askSize: num(fields[TICK_FIELDS.ASK_SIZE]) ?? undefined,
    volume: num(fields[TICK_FIELDS.VOLUME]) ?? undefined,
    timestamp: Date.now(),
  };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function mapOrderType(t: BrokerOrderRequest["orderType"]): IbkrOrderRequest["orderType"] {
  switch (t) {
    case "MARKET": return "MKT";
    case "LIMIT": return "LMT";
    case "STOP": return "STP";
    case "STOP_LIMIT": return "STOP_LIMIT";
  }
}

function mapSide(s: BrokerOrderRequest["side"]): IbkrOrderRequest["side"] {
  switch (s) {
    case "BUY":
    case "BUY_TO_OPEN":
    case "BUY_TO_CLOSE":
      return "BUY";
    case "SELL":
    case "SELL_TO_OPEN":
    case "SELL_TO_CLOSE":
      return "SELL";
  }
}

function mapOrderStatus(s: string): BrokerOrderStatus["status"] {
  const upper = s.toUpperCase();
  if (upper.includes("FILLED")) return "FILLED";
  if (upper.includes("CANCEL")) return "CANCELED";
  if (upper.includes("REJECT")) return "REJECTED";
  if (upper.includes("EXPIRE")) return "EXPIRED";
  if (upper.includes("SUBMITTED") || upper.includes("PRESUBMITTED") || upper.includes("WORKING")) return "WORKING";
  if (upper.includes("PARTIAL")) return "PARTIAL";
  return "UNKNOWN";
}
