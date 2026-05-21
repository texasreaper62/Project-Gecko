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

  async getOptionChain(q: OptionChainQuery): Promise<NormalizedOptionChain | null> {
    // Walk IBKR's three-step resolution:
    // 1. Resolve underlying conid (cached).
    // 2. Fetch strikes for the target expiration month.
    // 3. For each ATM-ish strike, fetch /secdef/info to get the contract conid,
    //    then /marketdata/snapshot for bid/ask/greeks.
    const underlyingConid = await this.resolveEquityConidCached(q.underlying);
    const month = ibkrMonth(q.fromDate);

    // Pick a reasonable strike count (~20) centered on current price.
    const undQuote = await this.getQuote(q.underlying);
    const underlyingPrice = undQuote?.last ?? 0;
    if (underlyingPrice <= 0) {
      log.warn("getOptionChain: no underlying price", { underlying: q.underlying });
      return null;
    }

    const strikesResp = await this.rest.getOptionStrikes(underlyingConid, month);
    const callStrikes = strikesResp.call ?? [];
    const putStrikes = strikesResp.put ?? [];
    if (callStrikes.length === 0 && putStrikes.length === 0) {
      log.info("getOptionChain: no strikes for month", { underlying: q.underlying, month });
      return null;
    }

    // Restrict to strikes near the money (10 above + 10 below).
    const filterAtm = (strikes: readonly number[]): readonly number[] => {
      const sorted = [...strikes].sort((a, b) => Math.abs(a - underlyingPrice) - Math.abs(b - underlyingPrice));
      return sorted.slice(0, 20);
    };

    const callRing = q.contractType === "PUT" ? [] : filterAtm(callStrikes);
    const putRing = q.contractType === "CALL" ? [] : filterAtm(putStrikes);

    const calls = await this.fetchOptionContracts(underlyingConid, q.underlying, month, callRing, "C");
    const puts = await this.fetchOptionContracts(underlyingConid, q.underlying, month, putRing, "P");

    return {
      underlying: q.underlying.toUpperCase(),
      underlyingPrice,
      expiration: q.fromDate,
      calls,
      puts,
    };
  }

  private async fetchOptionContracts(
    underlyingConid: number,
    underlying: string,
    month: string,
    strikes: readonly number[],
    right: "C" | "P",
  ): Promise<NormalizedOptionChain["calls"]> {
    if (strikes.length === 0) return [];

    // Resolve conids for each strike. Parallel but capped.
    const concurrency = 4;
    const allContracts: { conid: number; strike: number; symbol: string; maturityDate: string }[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < strikes.length) {
        const idx = cursor++;
        const strike = strikes[idx];
        try {
          const info = await this.rest.getOptionContractInfo(underlyingConid, month, strike, right);
          for (const c of info) {
            allContracts.push({ conid: c.conid, strike: c.strike, symbol: c.symbol, maturityDate: c.maturityDate });
          }
        } catch (err) {
          log.debug("getOptionContractInfo failed", { strike, right, error: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (allContracts.length === 0) return [];

    // Pull snapshots for all contract conids at once.
    const conids = allContracts.map((c) => c.conid);
    const snapshots = await this.rest.getSnapshot(conids, "31,84,86,85,88,7283,7308,7309,7310,7311");

    return allContracts.map((c) => {
      const snap = snapshots.find((s) => s.conid === c.conid) ?? null;
      const bid = numOrZero(snap?.["84"]);
      const ask = numOrZero(snap?.["86"]);
      const last = numOrZero(snap?.["31"]);
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
      const exp = parseIbkrDate(c.maturityDate);   // "20260517"
      const osi = formatOsiSymbol(underlying, exp, c.strike, right);
      this.conidCache.set(osi, c.conid);
      this.conidToSymbol.set(c.conid, osi);
      return {
        instrument: {
          assetClass: "option" as const,
          underlying: underlying.toUpperCase(),
          expiration: exp,
          strike: c.strike,
          optionType: right === "C" ? "CALL" as const : "PUT" as const,
          osiSymbol: osi,
        },
        bid,
        ask,
        mid,
        // Greeks: 7308 delta, 7309 gamma, 7310 theta, 7311 vega
        delta: numOrZero(snap?.["7308"]),
        gamma: numOrZero(snap?.["7309"]),
        theta: numOrZero(snap?.["7310"]),
        iv: numOrZero(snap?.["7283"]),
      };
    });
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

  async subscribeOptions(osiSymbols: readonly string[]): Promise<void> {
    for (const osi of osiSymbols) {
      let conid = this.conidCache.get(osi);
      if (conid === undefined) {
        const parsed = parseOsiSymbol(osi);
        if (!parsed) {
          log.warn("Could not parse OSI symbol for IBKR subscription", { osi });
          continue;
        }
        const underlyingConid = await this.resolveEquityConidCached(parsed.underlying);
        const month = ibkrMonth(parsed.expiration);
        const info = await this.rest.getOptionContractInfo(underlyingConid, month, parsed.strike, parsed.right);
        if (info.length === 0) {
          log.warn("IBKR could not resolve option symbol for subscription", { osi });
          continue;
        }
        conid = info[0].conid;
        this.conidCache.set(osi, conid);
      }
      this.conidToSymbol.set(conid, osi);
      this.stream.subscribeOption(conid);
    }
  }

  async subscribeAccountActivity(): Promise<void> {
    this.stream.subscribeLiveOrders();
  }

  // ----- Internals -----

  private async resolveConid(instrument: BrokerOrderRequest["instrument"]): Promise<number> {
    if (instrument.assetClass === "equity") {
      return this.resolveEquityConidCached(instrument.symbol);
    }
    // Option: try the OSI cache first (populated by getOptionChain). If miss,
    // resolve via underlying conid + month + strike + right.
    const cached = this.conidCache.get(instrument.osiSymbol);
    if (cached !== undefined) return cached;

    const underlyingConid = await this.resolveEquityConidCached(instrument.underlying);
    const month = ibkrMonth(instrument.expiration);
    const right: "C" | "P" = instrument.optionType === "CALL" ? "C" : "P";
    const info = await this.rest.getOptionContractInfo(underlyingConid, month, instrument.strike, right);
    if (info.length === 0) {
      throw new Error(`IBKR could not resolve option ${instrument.osiSymbol}`);
    }
    const conid = info[0].conid;
    this.conidCache.set(instrument.osiSymbol, conid);
    this.conidToSymbol.set(conid, instrument.osiSymbol);
    return conid;
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

function numOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

// Convert YYYY-MM-DD to "MMMYY" (IBKR's expected month format).
function ibkrMonth(yyyymmdd: string): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const m = months[d.getUTCMonth()];
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${m}${yy}`;
}

// Parse "20260517" -> "2026-05-17".
function parseIbkrDate(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// Build OSI 21-char symbol from underlying + ISO date + strike + right.
// e.g. SPY 2026-05-17 500.0 C -> "SPY   260517C00500000"
function formatOsiSymbol(underlying: string, isoDate: string, strike: number, right: "C" | "P"): string {
  const ticker = underlying.toUpperCase().padEnd(6, " ");
  const d = new Date(`${isoDate}T00:00:00Z`);
  const yymmdd = `${String(d.getUTCFullYear()).slice(-2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${ticker}${yymmdd}${right}${strikeStr}`;
}

// Inverse of the above. Returns { underlying, expiration (YYYY-MM-DD), strike, right }.
function parseOsiSymbol(osi: string): { underlying: string; expiration: string; strike: number; right: "C" | "P" } | null {
  if (osi.length !== 21) return null;
  const underlying = osi.slice(0, 6).trim();
  const yy = osi.slice(6, 8);
  const mm = osi.slice(8, 10);
  const dd = osi.slice(10, 12);
  const right = osi.slice(12, 13);
  const strikeRaw = osi.slice(13);
  if (right !== "C" && right !== "P") return null;
  const yyyy = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
  const strike = Number(strikeRaw) / 1000;
  if (!Number.isFinite(strike)) return null;
  return { underlying, expiration: `${yyyy}-${mm}-${dd}`, strike, right };
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
