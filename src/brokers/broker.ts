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

// Native broker-side bracket: parent entry + child stop + child take-profit,
// where the two children are linked in an OCA group server-side. This is
// the only safe primitive for risk management — client-monitored stops fail
// when the bot dies or the broker disconnects.
export interface BrokerBracketRequest {
  readonly entry: BrokerOrderRequest;
  readonly stopPrice: number;
  readonly takeProfitPrice: number;
  readonly stopTif?: "DAY" | "GTC";
  readonly takeProfitTif?: "DAY" | "GTC";
}

export interface BrokerBracketResult {
  readonly entryOrderId: string;
  readonly stopOrderId: string;
  readonly takeProfitOrderId: string;
  readonly raw?: unknown;
}

export interface BrokerOrderStatus {
  readonly orderId: string;
  readonly status: "WORKING" | "FILLED" | "PARTIAL" | "CANCELED" | "REJECTED" | "EXPIRED" | "UNKNOWN";
  readonly filledQuantity: number;
  readonly avgPrice: number;
}

// Snapshot of a position the broker reports holding. Used for boot-time
// reconciliation: the bot must align its in-memory state with the broker's
// truth before any strategy fires.
export interface BrokerPositionSnapshot {
  readonly instrument: EquityInstrument | OptionInstrument;
  readonly quantity: number;            // signed: positive = long, negative = short
  readonly avgCost: number;
  readonly marketPrice?: number;
  readonly unrealizedPnl?: number;
}

// Session/connection health for the pre-open check. `connected` means
// the broker is reachable. `authenticated` means we can place orders.
// Both must be true for the bot to operate. `message` is human-readable
// detail surfaced into the Telegram alert.
export interface BrokerHealthStatus {
  readonly ok: boolean;
  readonly authenticated: boolean;
  readonly connected: boolean;
  readonly message: string;
}

// Snapshot of a working order the broker reports as live. Used for
// boot-time reconciliation alongside positions.
export interface BrokerOpenOrder {
  readonly orderId: string;
  readonly instrument: EquityInstrument | OptionInstrument;
  readonly side: "BUY" | "SELL" | "BUY_TO_OPEN" | "SELL_TO_OPEN" | "BUY_TO_CLOSE" | "SELL_TO_CLOSE";
  readonly quantity: number;
  readonly remaining: number;
  readonly orderType: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  readonly limitPrice?: number;
  readonly stopPrice?: number;
  readonly status: string;
  readonly parentOrderId?: string;
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

// The shape every broker adapter must satisfy.
export interface Broker {
  // Lifecycle
  start(): Promise<void>;
  stop(): void;

  // Account state
  getAccountSnapshot(): Promise<AccountSnapshot>;

  // Orders
  placeOrder(req: BrokerOrderRequest): Promise<BrokerSubmitResult>;
  // Native broker-side bracket. Entry + stop + take-profit submitted as a
  // single OCA group so the stop/target live on the broker even if the bot
  // dies. Every entry that has a stop+target SHOULD go through this path.
  placeBracket(req: BrokerBracketRequest): Promise<BrokerBracketResult>;
  cancelOrder(orderId: string): Promise<void>;
  getOrderStatus(orderId: string): Promise<BrokerOrderStatus | null>;

  // Boot-time reconciliation. Called BEFORE any strategy fires so the bot
  // sees what the broker thinks it holds, not what its local JSONL says.
  getPositions(): Promise<readonly BrokerPositionSnapshot[]>;
  getOpenOrders(): Promise<readonly BrokerOpenOrder[]>;

  // Session-health probe. Used by the pre-open auth check to surface a
  // dead session via Telegram before market open, giving the operator
  // time to re-login manually. Returns false + diagnostic message when
  // a fresh browser login is needed.
  healthCheck(): Promise<BrokerHealthStatus>;

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
