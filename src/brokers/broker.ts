// Broker-agnostic adapter interface.
//
// The orchestrator and strategies talk to this thin interface; concrete
// implementations live under src/brokers/schwab/ and src/brokers/ibkr/.
//
// Why this exists: strategies subscribe to ticks and submit orders without
// caring whether the underlying venue is Schwab or IBKR. Schwab uses
// uppercase tickers and OSI option symbols; IBKR uses numeric conids. The
// adapter resolves between those conventions internally.

import type {
  AccountSnapshot,
  Bar,
  EquityInstrument,
  OptionInstrument,
} from "../core/types.js";

export type StreamDataKind = "equity-tick" | "option-tick" | "account-activity";

export interface NormalizedTick {
  readonly symbol: string;        // equity ticker or OSI symbol
  readonly last: number;
  readonly bid?: number;
  readonly ask?: number;
  readonly mark?: number;
  readonly bidSize?: number;
  readonly askSize?: number;
  readonly volume?: number;
  readonly timestamp: number;
}

export type BrokerStreamHandler = (kind: StreamDataKind, ticks: readonly NormalizedTick[]) => void;

export interface BrokerSubmitResult {
  readonly orderId: string;
  readonly raw?: unknown;
}

export interface BrokerOrderRequest {
  readonly instrument: EquityInstrument | OptionInstrument;
  readonly side: "BUY" | "SELL" | "BUY_TO_OPEN" | "SELL_TO_OPEN" | "BUY_TO_CLOSE" | "SELL_TO_CLOSE";
  readonly quantity: number;
  readonly orderType: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  readonly limitPrice?: number;
  readonly stopPrice?: number;
  readonly tif: "DAY" | "GTC" | "IOC";
}

export interface BrokerOrderStatus {
  readonly orderId: string;
  readonly status: "WORKING" | "FILLED" | "PARTIAL" | "CANCELED" | "REJECTED" | "EXPIRED" | "UNKNOWN";
  readonly filledQuantity: number;
  readonly avgPrice: number;
}

export interface OptionChainQuery {
  readonly underlying: string;
  readonly fromDate: string;        // YYYY-MM-DD
  readonly toDate: string;
  readonly contractType?: "CALL" | "PUT" | "BOTH";
}

export interface NormalizedOptionContract {
  readonly instrument: OptionInstrument;
  readonly bid: number;
  readonly ask: number;
  readonly mid: number;
  readonly delta?: number;
  readonly gamma?: number;
  readonly theta?: number;
  readonly iv?: number;
  readonly openInterest?: number;
  readonly volume?: number;
}

export interface NormalizedOptionChain {
  readonly underlying: string;
  readonly underlyingPrice: number;
  readonly expiration: string;
  readonly calls: readonly NormalizedOptionContract[];
  readonly puts: readonly NormalizedOptionContract[];
}

export interface HistoricalBarsQuery {
  readonly symbol: string;
  readonly frequency: "1min" | "5min" | "15min" | "1h" | "1d";
  readonly lookback: string;        // e.g. "1d", "5d", "60d", "1y"
  readonly extendedHours?: boolean;
}

// Runtime guard for call sites that accept either a raw SchwabRest client
// (legacy data path, richer batch endpoints) or any Broker adapter. SchwabRest
// has none of these methods, so checking two is unambiguous.
export function isBroker(x: unknown): x is Broker {
  return typeof x === "object" && x !== null
    && typeof (x as Broker).getHistoricalBars === "function"
    && typeof (x as Broker).placeOrder === "function";
}

// The shape every broker adapter must satisfy.
export interface Broker {
  // Lifecycle
  start(): Promise<void>;
  stop(): void;

  // Account state
  getAccountSnapshot(): Promise<AccountSnapshot>;

  // Orders
  placeOrder(req: BrokerOrderRequest): Promise<BrokerSubmitResult>;
  cancelOrder(orderId: string): Promise<void>;
  getOrderStatus(orderId: string): Promise<BrokerOrderStatus | null>;

  // Market data
  getOptionChain(q: OptionChainQuery): Promise<NormalizedOptionChain | null>;
  getHistoricalBars(q: HistoricalBarsQuery): Promise<readonly Bar[]>;
  getQuote(symbol: string): Promise<NormalizedTick | null>;

  // Streaming
  setStreamHandler(h: BrokerStreamHandler): void;
  subscribeEquities(symbols: readonly string[]): Promise<void>;
  subscribeOptions(osiSymbols: readonly string[]): Promise<void>;
  subscribeAccountActivity(): Promise<void>;

  // Identity
  readonly name: "schwab" | "ibkr";
  readonly orderLatencyTargetMs: number;     // for logging / monitoring
}
