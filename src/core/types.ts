// Shared types for the Gecko equity/option trading bot.
// Broker-agnostic where possible; Schwab-specific shapes live under brokers/schwab/.

// -- Logging --

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly ts: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

// -- WebSocket plumbing --

export interface WsManagerConfig {
  readonly url: string;
  readonly name: string;
  readonly pingInterval?: number;
  readonly pongTimeout?: number;
  readonly maxReconnectDelay?: number;
  readonly initialReconnectDelay?: number;
}

export type FeedStatus = "connected" | "connecting" | "disconnected" | "error";

export interface FeedHealth {
  readonly name: string;
  readonly status: FeedStatus;
  readonly lastMessage: number;
  readonly reconnectCount: number;
  readonly error?: string;
}

// -- Instrument basics --

export type AssetClass = "equity" | "option";
export type OptionType = "CALL" | "PUT";

export interface EquityInstrument {
  readonly assetClass: "equity";
  readonly symbol: string;
}

export interface OptionInstrument {
  readonly assetClass: "option";
  readonly underlying: string;
  readonly expiration: string;       // YYYY-MM-DD
  readonly strike: number;
  readonly optionType: OptionType;
  readonly osiSymbol: string;        // OCC OSI 21-character symbol, e.g. "SPY   260612C00500000"
}

export type Instrument = EquityInstrument | OptionInstrument;

// -- Market data --

export interface Quote {
  readonly symbol: string;            // equity ticker or OSI
  readonly bid: number;
  readonly ask: number;
  readonly last: number;
  readonly bidSize: number;
  readonly askSize: number;
  readonly timestamp: number;         // Unix ms
}

export interface Bar {
  readonly symbol: string;
  readonly timestamp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

// -- Orders --

export type OrderSide = "BUY" | "SELL" | "BUY_TO_OPEN" | "SELL_TO_OPEN" | "BUY_TO_CLOSE" | "SELL_TO_CLOSE";
export type OrderType = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
export type TimeInForce = "DAY" | "GTC" | "IOC" | "FOK";
export type OrderStatus = "pending" | "working" | "filled" | "partial" | "cancelled" | "rejected" | "expired";

export interface OrderRequest {
  readonly instrument: Instrument;
  readonly side: OrderSide;
  readonly quantity: number;          // shares or contracts
  readonly orderType: OrderType;
  readonly timeInForce: TimeInForce;
  readonly limitPrice?: number;
  readonly stopPrice?: number;
}

export interface OrderResult {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly filledQuantity: number;
  readonly avgFillPrice: number;
  readonly fees: number;
  readonly timestamp: number;
  readonly error?: string;
}

// -- Positions --

export interface Position {
  readonly instrument: Instrument;
  readonly side: "LONG" | "SHORT";
  readonly entryPrice: number;
  readonly quantity: number;
  readonly openTimestamp: number;
  readonly strategy: StrategyType;
  readonly metadata: Record<string, unknown>;
  currentPrice: number;
  unrealizedPnl: number;
}

// -- Strategies --

export type StrategyType = "orb" | "dte0-spy" | "mean-reversion" | "pairs-trader" | "earnings-catalyst";

export interface SetupCandidate {
  readonly instrument: Instrument;
  readonly strategy: StrategyType;
  readonly timestamp: number;
  readonly score: number;             // 0-1, strategy-specific quality score
  readonly metadata: Record<string, unknown>;
}

export interface TradeSignal {
  readonly id: string;
  readonly strategy: StrategyType;
  readonly timestamp: number;
  readonly description: string;
  readonly order: OrderRequest;
  readonly stopPrice: number;
  readonly takeProfitPrice: number;
  readonly riskUsd: number;
  readonly rewardUsd: number;
  readonly metadata: Record<string, unknown>;
}

// -- Account / risk --

export interface AccountSnapshot {
  readonly cashBalance: number;
  readonly buyingPower: number;
  readonly dayTradeBuyingPower: number;
  readonly equity: number;
  readonly dayTradeCount: number;     // rolling 5-day day-trade count
  readonly timestamp: number;
}

// -- Config --

export interface AppConfig {
  // Schwab API
  readonly schwabClientId: string;
  readonly schwabClientSecret: string;
  readonly schwabRedirectUri: string;
  readonly schwabAccountHash: string;          // account number hash for trading

  // Broker selection
  readonly broker: "schwab" | "ibkr";

  // IBKR
  readonly ibkrBaseUrl: string;          // default https://localhost:5000/v1/api

  // LLM (Anthropic Claude for setup classification)
  readonly anthropicApiKey: string;
  readonly llmEnabled: boolean;
  readonly llmModel: string;

  // Agent brain (Claude validates EVERY trade with full market context)
  readonly agentBrainEnabled: boolean;
  readonly agentBrainMinConviction: number;    // 0-100, default 70
  readonly agentBrainMinConvictionLong: number;   // override for LONG, default 60
  readonly agentBrainMinConvictionShort: number;  // override for SHORT, default 75

  // Kelly-bounded sizing
  readonly kellyEnabled: boolean;
  readonly kellyFraction: number;              // 0.25 = quarter-Kelly (conservative)

  // Regime-aware sizing
  readonly regimeAwareEnabled: boolean;

  // Trading mode
  readonly liveTrading: boolean;
  readonly killSwitch: boolean;

  // Risk
  readonly maxRiskPerTradePct: number;         // % of account risked per trade (e.g. 1.0)
  readonly maxConcurrentEquityPositions: number;
  readonly maxConcurrentOptionPositions: number;
  readonly dailyLossLimitPct: number;          // halt for the day at this drawdown
  readonly maxDayTrades: number;               // hard cap per day

  // Engine A (ORB equity)
  readonly orbEnabled: boolean;
  readonly orbMinGapPct: number;
  readonly orbMinPremarketVolume: number;
  readonly orbMinPrice: number;
  readonly orbMaxPrice: number;

  // Engine B (0DTE SPY)
  readonly dte0Enabled: boolean;
  readonly dte0MaxContractsPerTrade: number;
  readonly dte0MaxTradesPerDay: number;

  // Notifications
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly discordWebhookUrl: string;

  // Logging
  readonly logLevel: LogLevel;
}
