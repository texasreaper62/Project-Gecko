// Schwab adapter satisfying the broker-agnostic Broker interface.
//
// Thin wrapper around the existing SchwabAuth + SchwabRest + SchwabStream
// classes. Exists so the orchestrator can hold a single `Broker` reference
// and swap implementations via config without touching strategy code.

import { createLogger } from "../../core/logger.js";
import { etDate } from "../../utils/time.js";
import type {
  AccountSnapshot,
  Bar,
  OptionInstrument,
} from "../../core/types.js";
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
} from "../broker.js";
import type { SchwabAuth } from "./auth.js";
import type { SchwabRest } from "./rest.js";
import type { SchwabStream } from "./stream.js";
import { buildEquityOrder, buildOptionOrder } from "../../execution/order-builder.js";

const log = createLogger("schwab-broker");

const EQUITY_TICK_FIELDS = { LAST: "3", BID: "1", ASK: "2", VOLUME: "8" } as const;
const OPTION_TICK_FIELDS = { BID: "2", ASK: "3", MARK: "38" } as const;

export class SchwabBroker implements Broker {
  readonly name = "schwab" as const;
  readonly orderLatencyTargetMs = 350;

  private handler: BrokerStreamHandler | null = null;
  private accountHash = "";

  constructor(
    private readonly auth: SchwabAuth,
    private readonly rest: SchwabRest,
    private readonly stream: SchwabStream,
    configuredAccountHash: string,
  ) {
    this.accountHash = configuredAccountHash;
  }

  async start(): Promise<void> {
    // Auth is loaded externally; the orchestrator already calls auth.load()
    // before constructing the broker. Here we resolve the account hash
    // against /accounts/accountNumbers in case the configured one doesn't
    // match (typical fresh-account behavior).
    try {
      const list = await this.rest.getAccountNumbers();
      const match = list.find((a) => a.hashValue === this.accountHash);
      if (!match && list[0]) {
        log.warn("Configured Schwab hash not found; using first available");
        this.accountHash = list[0].hashValue;
      }
    } catch (err) {
      log.warn("Schwab account list lookup failed", { error: err instanceof Error ? err.message : String(err) });
    }

    this.stream.setDataHandler((service, content) => this.dispatchStream(service, content));
    await this.stream.start();
  }

  stop(): void {
    this.stream.stop();
    this.auth.stopAutoRefresh();
  }

  async getAccountSnapshot(): Promise<AccountSnapshot> {
    const acct = await this.rest.getAccount(this.accountHash, true);
    const cur = acct.securitiesAccount.currentBalances;
    return {
      cashBalance: cur?.cashBalance ?? 0,
      buyingPower: cur?.buyingPower ?? 0,
      dayTradeBuyingPower: cur?.dayTradingBuyingPower ?? cur?.buyingPower ?? 0,
      equity: cur?.equity ?? cur?.liquidationValue ?? 0,
      dayTradeCount: acct.securitiesAccount.roundTrips ?? 0,
      timestamp: Date.now(),
    };
  }

  async placeOrder(req: BrokerOrderRequest): Promise<BrokerSubmitResult> {
    const payload = req.instrument.assetClass === "equity"
      ? buildEquityOrder(toOrderShape(req))
      : buildOptionOrder(toOrderShape(req));
    const result = await this.rest.placeOrder(this.accountHash, payload);
    return { orderId: result.orderId };
  }

  // Schwab supports OCO and trigger-OCO via orderStrategyType "OCO" /
  // "TRIGGER" but the path is more involved than IBKR's native bracket.
  // For now the Schwab adapter is a fallback that is not wired to live
  // trading; throw an explicit error so any code path that hits it is
  // visible. When Schwab is reactivated, fill this in with a proper
  // TRIGGER + OCO order tree built by order-builder.
  async placeBracket(_req: BrokerBracketRequest): Promise<BrokerBracketResult> {
    throw new Error("SchwabBroker.placeBracket not implemented; Schwab is fallback-only at v1");
  }

  async getPositions(): Promise<readonly BrokerPositionSnapshot[]> {
    // Schwab is not wired for v1 live trading; return empty so the
    // reconciliation step on boot is a no-op rather than a crash.
    log.warn("SchwabBroker.getPositions called but not implemented; returning []");
    return [];
  }

  async getOpenOrders(): Promise<readonly BrokerOpenOrder[]> {
    log.warn("SchwabBroker.getOpenOrders called but not implemented; returning []");
    return [];
  }

  async healthCheck(): Promise<BrokerHealthStatus> {
    // Stub: Schwab is fallback-only at v1. If reactivated, ping
    // /trader/v1/accounts to verify the OAuth token is still alive.
    return { ok: true, authenticated: true, connected: true, message: "SchwabBroker.healthCheck: stub (fallback path, not wired)" };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.rest.cancelOrder(this.accountHash, orderId);
  }

  async getOrderStatus(orderId: string): Promise<BrokerOrderStatus | null> {
    const order = await this.rest.getOrder(this.accountHash, orderId);
    let filled = 0;
    let notional = 0;
    for (const activity of order.orderActivityCollection ?? []) {
      if (activity.activityType !== "EXECUTION") continue;
      for (const leg of activity.executionLegs ?? []) {
        filled += leg.quantity;
        notional += leg.price * leg.quantity;
      }
    }
    return {
      orderId: String(order.orderId),
      status: mapSchwabStatus(order.status),
      filledQuantity: filled,
      avgPrice: filled > 0 ? notional / filled : 0,
    };
  }

  async getOptionChain(q: OptionChainQuery): Promise<NormalizedOptionChain | null> {
    const chain = await this.rest.getOptionChain({
      symbol: q.underlying,
      contractType: q.contractType === "BOTH" || !q.contractType ? "ALL" : q.contractType,
      strikeCount: 20,
      includeUnderlyingQuote: true,
      strategy: "SINGLE",
      fromDate: q.fromDate,
      toDate: q.toDate,
    });
    const underlyingPrice = chain.underlying?.last ?? chain.underlying?.bid ?? 0;
    if (underlyingPrice <= 0) return null;

    const callKey = Object.keys(chain.callExpDateMap).find((k) => k.startsWith(q.fromDate));
    const putKey = Object.keys(chain.putExpDateMap).find((k) => k.startsWith(q.fromDate));
    if (!callKey || !putKey) return null;

    type Contract = { symbol: string; strikePrice: number; bid: number; ask: number; mark?: number; delta?: number; gamma?: number; theta?: number; volatility?: number; openInterest?: number; totalVolume?: number; expirationDate: string };
    type ChainOut = ReadonlyArray<NormalizedOptionChain["calls"][number]>;
    const flatten = (map: Record<string, ReadonlyArray<Contract>>): ChainOut => {
      const out2: Array<NormalizedOptionChain["calls"][number]> = [];
      for (const arr of Object.values(map)) {
        for (const c of arr) {
          const inst: OptionInstrument = {
            assetClass: "option",
            underlying: q.underlying.toUpperCase(),
            expiration: c.expirationDate.slice(0, 10),
            strike: c.strikePrice,
            optionType: "CALL",       // overwritten below
            osiSymbol: c.symbol,
          };
          const mid = c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : (c.mark ?? 0);
          out2.push({
            instrument: inst,
            bid: c.bid,
            ask: c.ask,
            mid,
            delta: c.delta,
            gamma: c.gamma,
            theta: c.theta,
            iv: c.volatility,
            openInterest: c.openInterest,
            volume: c.totalVolume,
          });
        }
      }
      return out2;
    };

    const out: NormalizedOptionChain = {
      underlying: q.underlying.toUpperCase(),
      underlyingPrice,
      expiration: q.fromDate,
      calls: flatten(chain.callExpDateMap[callKey] as never).map((c) => ({
        ...c,
        instrument: { ...c.instrument, optionType: "CALL" },
      })),
      puts: flatten(chain.putExpDateMap[putKey] as never).map((c) => ({
        ...c,
        instrument: { ...c.instrument, optionType: "PUT" },
      })),
    };
    return out;
  }

  async getHistoricalBars(q: HistoricalBarsQuery): Promise<readonly Bar[]> {
    const freqType = q.frequency === "1d" ? "daily" : "minute";
    const freq = q.frequency === "1min" ? 1 : q.frequency === "5min" ? 5 : q.frequency === "15min" ? 15 : q.frequency === "1h" ? 60 : 1;
    const lookbackMs = parseLookback(q.lookback);
    const endMs = Date.now();
    const startMs = endMs - lookbackMs;
    const resp = await this.rest.getPriceHistory({
      symbol: q.symbol,
      periodType: freqType === "daily" ? "year" : "day",
      frequencyType: freqType,
      frequency: freq,
      startDate: startMs,
      endDate: endMs,
      needExtendedHoursData: q.extendedHours ?? false,
    });
    return resp.candles.map((c) => ({
      symbol: q.symbol.toUpperCase(),
      timestamp: c.datetime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }

  async getQuote(symbol: string): Promise<NormalizedTick | null> {
    const quotes = await this.rest.getQuotes([symbol]);
    const q = quotes[symbol.toUpperCase()];
    if (!q || !q.quote) return null;
    return {
      symbol: symbol.toUpperCase(),
      last: q.quote.lastPrice,
      bid: q.quote.bidPrice,
      ask: q.quote.askPrice,
      bidSize: q.quote.bidSize,
      askSize: q.quote.askSize,
      volume: q.quote.totalVolume,
      timestamp: q.quote.tradeTime ?? Date.now(),
    };
  }

  setStreamHandler(h: BrokerStreamHandler): void {
    this.handler = h;
  }

  async subscribeEquities(symbols: readonly string[]): Promise<void> {
    this.stream.subscribeEquities(symbols);
  }

  async subscribeOptions(osiSymbols: readonly string[]): Promise<void> {
    this.stream.subscribeOptions(osiSymbols);
  }

  async subscribeAccountActivity(): Promise<void> {
    this.stream.subscribeAccountActivity();
  }

  getAccountHash(): string {
    return this.accountHash;
  }

  // ----- Internals -----

  private dispatchStream(service: string, content: readonly Record<string, unknown>[]): void {
    if (!this.handler) return;
    if (service === "LEVELONE_EQUITIES") {
      const ticks: NormalizedTick[] = [];
      for (const row of content) {
        const sym = typeof row["0"] === "string" ? (row["0"] as string) : "";
        const last = typeof row[EQUITY_TICK_FIELDS.LAST] === "number" ? row[EQUITY_TICK_FIELDS.LAST] as number : NaN;
        if (!sym || !Number.isFinite(last) || last <= 0) continue;
        ticks.push({
          symbol: sym,
          last,
          bid: numField(row, EQUITY_TICK_FIELDS.BID),
          ask: numField(row, EQUITY_TICK_FIELDS.ASK),
          volume: numField(row, EQUITY_TICK_FIELDS.VOLUME),
          timestamp: Date.now(),
        });
      }
      if (ticks.length > 0) this.handler("equity-tick", ticks);
    } else if (service === "LEVELONE_OPTIONS") {
      const ticks: NormalizedTick[] = [];
      for (const row of content) {
        const sym = typeof row["0"] === "string" ? (row["0"] as string) : "";
        const bid = numField(row, OPTION_TICK_FIELDS.BID);
        const ask = numField(row, OPTION_TICK_FIELDS.ASK);
        const mark = numField(row, OPTION_TICK_FIELDS.MARK);
        const mid = bid !== undefined && ask !== undefined && bid > 0 && ask > 0
          ? (bid + ask) / 2
          : mark;
        if (!sym || mid === undefined || mid <= 0) continue;
        ticks.push({
          symbol: sym,
          last: mid,
          bid,
          ask,
          mark,
          timestamp: Date.now(),
        });
      }
      if (ticks.length > 0) this.handler("option-tick", ticks);
    } else if (service === "ACCT_ACTIVITY") {
      this.handler("account-activity", []);
    }
  }
}

function numField(row: Record<string, unknown>, key: string): number | undefined {
  const v = row[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function toOrderShape(req: BrokerOrderRequest): {
  instrument: BrokerOrderRequest["instrument"];
  side: BrokerOrderRequest["side"];
  quantity: number;
  orderType: BrokerOrderRequest["orderType"];
  limitPrice?: number;
  stopPrice?: number;
  timeInForce: "DAY" | "GTC" | "IOC";
} {
  return {
    instrument: req.instrument,
    side: req.side,
    quantity: req.quantity,
    orderType: req.orderType,
    limitPrice: req.limitPrice,
    stopPrice: req.stopPrice,
    timeInForce: req.tif,
  };
}

function parseLookback(s: string): number {
  const m = s.match(/^(\d+)\s*([dmy])$/);
  if (!m) return 24 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === "d") return n * 24 * 60 * 60 * 1000;
  if (unit === "m") return n * 30 * 24 * 60 * 60 * 1000;
  if (unit === "y") return n * 365 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function mapSchwabStatus(s: string): BrokerOrderStatus["status"] {
  const upper = s.toUpperCase();
  if (upper === "FILLED") return "FILLED";
  if (upper === "CANCELED") return "CANCELED";
  if (upper === "REJECTED") return "REJECTED";
  if (upper === "EXPIRED") return "EXPIRED";
  if (upper === "WORKING" || upper === "QUEUED" || upper === "ACCEPTED" || upper.startsWith("AWAITING") || upper.startsWith("PENDING")) return "WORKING";
  return "UNKNOWN";
}

// etDate import kept for downstream consumers expecting it on the broker; not used here.
void etDate;
