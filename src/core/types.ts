// All shared interfaces and types for Project Gecko

// -- Price and Market Data --

export interface SpotPrice {
  readonly symbol: string;       // "BTC" | "ETH"
  readonly price: number;
  readonly timestamp: number;    // Unix ms
  readonly source: "binance" | "coinbase";
}

export interface PriceState {
  readonly binance: SpotPrice | null;
  readonly coinbase: SpotPrice | null;
  readonly confirmedPrice: number | null;   // Only set when both feeds agree
  readonly lastUpdate: number;
}

export interface PolymarketToken {
  readonly tokenId: string;
  readonly outcome: "YES" | "NO";
  readonly price: number;
  readonly winner: boolean;
}

export interface PolymarketMarket {
  readonly conditionId: string;
  readonly questionId: string;
  readonly question: string;
  readonly slug: string;
  readonly tokens: readonly PolymarketToken[];
  readonly active: boolean;
  readonly closed: boolean;
  readonly negRisk: boolean;
  readonly endDateIso: string;
  readonly volume: number;
  readonly liquidity: number;
  readonly eventSlug: string;
  readonly eventTitle: string;
}

export interface OrderBookLevel {
  readonly price: number;
  readonly size: number;
}

export interface OrderBookSnapshot {
  readonly tokenId: string;
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly midpoint: number;
  readonly spread: number;
  readonly depth: number;        // Total USDC depth
  readonly timestamp: number;
}

// -- Trading --

export type TradeSide = "BUY" | "SELL";
export type OrderType = "GTC" | "FOK" | "GTD" | "FAK";

export interface TradeParams {
  readonly tokenId: string;
  readonly side: TradeSide;
  readonly price: number;
  readonly size: number;          // USDC amount
  readonly orderType: OrderType;
  readonly conditionId: string;
  readonly negRisk: boolean;
}

export interface TradeResult {
  readonly orderId: string;
  readonly status: "filled" | "partial" | "rejected" | "error";
  readonly fillPrice: number;
  readonly fillSize: number;
  readonly fees: number;
  readonly timestamp: number;
  readonly error?: string;
}

export interface Position {
  readonly conditionId: string;
  readonly tokenId: string;
  readonly side: TradeSide;
  readonly entryPrice: number;
  readonly size: number;
  readonly openTimestamp: number;
  readonly market: string;        // question/description
  currentPrice: number;
  unrealizedPnl: number;
}

export interface TradeRecord {
  readonly ts: string;
  readonly market: string;
  readonly conditionId: string;
  readonly side: TradeSide;
  readonly tokenId: string;
  readonly price: number;
  readonly size: number;
  readonly orderId: string;
  readonly status: string;
  readonly fillPrice: number;
  readonly fees: number;
  readonly pnl: number | null;
  readonly strategy: StrategyType;
}

// -- Strategies --

export type StrategyType = "temporal-arb" | "cross-platform" | "correlated-contracts";

export interface Opportunity {
  readonly id: string;
  readonly strategy: StrategyType;
  readonly timestamp: number;
  readonly description: string;
  readonly expectedSpread: number; // percentage
  readonly confidence: number;     // 0.0 - 1.0
  readonly params: TradeParams;
  readonly metadata: Record<string, unknown>;
}

export interface StrategyState {
  readonly enabled: boolean;
  readonly lastScan: number;
  readonly opportunitiesFound: number;
  readonly tradesExecuted: number;
}

// -- Feed Status --

export type FeedStatus = "connected" | "connecting" | "disconnected" | "error";

export interface FeedHealth {
  readonly name: string;
  readonly status: FeedStatus;
  readonly lastMessage: number;   // Unix ms
  readonly reconnectCount: number;
  readonly error?: string;
}

// -- Config --

export interface AppConfig {
  // Wallet
  readonly privateKey: string;
  readonly walletAddress: string;
  readonly funderAddress: string;
  readonly signatureType: number;

  // Polymarket
  readonly polymarketApiKey: string;
  readonly polymarketSecret: string;
  readonly polymarketPassphrase: string;
  readonly polymarketClobUrl: string;
  readonly polymarketChainId: number;

  // Polygon RPC
  readonly polygonRpcUrl: string;
  readonly polygonWsUrl: string;

  // Feeds
  readonly binanceWsUrl: string;
  readonly coinbaseWsUrl: string;

  // Kalshi (optional)
  readonly kalshiApiKey: string;
  readonly kalshiPrivateKeyPath: string;
  readonly kalshiApiUrl: string;

  // Trading
  readonly minSpreadThreshold: number;
  readonly maxPositionSize: number;
  readonly maxTotalExposure: number;
  readonly maxOpenPositions: number;
  readonly minLiquidity: number;
  readonly killSwitch: boolean;
  readonly liveTrading: boolean;

  // Monitoring
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly discordWebhookUrl: string;

  // Logging
  readonly logLevel: LogLevel;
}

// -- Logging --

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly ts: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

// -- WebSocket --

export interface WsManagerConfig {
  readonly url: string;
  readonly name: string;
  readonly pingInterval?: number;     // ms, default 30000
  readonly pongTimeout?: number;      // ms, default 10000
  readonly maxReconnectDelay?: number; // ms, default 60000
  readonly initialReconnectDelay?: number; // ms, default 1000
}

// -- Monitoring --

export interface DailySummary {
  readonly date: string;          // YYYY-MM-DD
  readonly totalTrades: number;
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly totalPnl: number;
  readonly totalFees: number;
  readonly netPnl: number;
  readonly maxDrawdown: number;
  readonly opportunities: number;
  readonly strategies: Record<StrategyType, StrategyState>;
}

export interface HealthStatus {
  readonly timestamp: number;
  readonly feeds: readonly FeedHealth[];
  readonly positions: number;
  readonly totalExposure: number;
  readonly walletBalance: number;
  readonly killSwitch: boolean;
  readonly uptime: number;
}
