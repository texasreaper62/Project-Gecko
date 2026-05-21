// IBKR Client Portal Web API request/response shapes.
// Reference: https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/
//            https://interactivebrokers.github.io/cpwebapi/
//
// Endpoints all live at /v1/api/* on either the locally-run Gateway
// (clientportal.gw, default https://localhost:5000) or IBKR's hosted
// gateway when using OAuth 2.0.
//
// Auth model:
//   - Sessions time out after ~6 minutes of inactivity.
//   - /tickle endpoint must be hit ~every 60 seconds to keep the session alive.
//   - OAuth 2.0 issues a bearer token; the gateway then maintains the session
//     via an `api={session_token}` cookie.
//
// REST shape note: every endpoint returns either a typed JSON object/array or
// an `{ error: string }` blob. We validate at the boundary.

// -- Session / auth --

export interface IbkrAuthStatus {
  readonly authenticated: boolean;
  readonly competing: boolean;        // another session is competing
  readonly connected: boolean;
  readonly message?: string;
  readonly MAC?: string;
  readonly serverInfo?: {
    readonly serverName?: string;
    readonly serverVersion?: string;
  };
}

export interface IbkrTickleResponse {
  readonly session: string;
  readonly ssoExpires: number;
  readonly collission: boolean;
  readonly userId?: number;
  readonly hmds?: { error?: string };
  readonly iserver?: {
    readonly authStatus?: IbkrAuthStatus;
  };
}

export interface PersistedIbkrTokens {
  readonly accessToken: string;
  readonly sessionToken: string;        // returned by /tickle and used as api=... cookie
  readonly expiresAt: number;           // Unix ms
}

// -- Accounts --

export interface IbkrAccount {
  readonly accountId: string;           // e.g. "U1234567"
  readonly accountAlias?: string;
  readonly accountType?: string;
  readonly currency?: string;
  readonly tradingType?: string;        // "INDIVIDUAL", "ORG", etc.
}

export interface IbkrPortfolioSummary {
  readonly accountId: string;
  readonly netliquidation?: { amount: number; currency: string };
  readonly availablefunds?: { amount: number; currency: string };
  readonly buyingpower?: { amount: number; currency: string };
  readonly cashbalance?: { amount: number; currency: string };
  readonly equitywithloanvalue?: { amount: number; currency: string };
  readonly grosspositionvalue?: { amount: number; currency: string };
  readonly maintmarginreq?: { amount: number; currency: string };
  readonly excessliquidity?: { amount: number; currency: string };
  readonly dayTradesRemaining?: number;
}

export interface IbkrPosition {
  readonly acctId: string;
  readonly conid: number;               // IBKR contract ID
  readonly contractDesc?: string;
  readonly position: number;
  readonly mktPrice: number;
  readonly mktValue: number;
  readonly avgCost: number;
  readonly avgPrice: number;
  readonly realizedPnl: number;
  readonly unrealizedPnl: number;
  readonly assetClass?: string;
  readonly currency?: string;
}

// -- Contracts --

export interface IbkrContract {
  readonly conid: number;
  readonly symbol: string;
  readonly secType: "STK" | "OPT" | "FUT" | "FOP" | "IND" | "CASH" | "WAR" | "BAG";
  readonly exchange?: string;
  readonly primaryExchange?: string;
  readonly currency?: string;
  readonly strike?: number;
  readonly right?: "C" | "P";
  readonly expiry?: string;             // YYYYMMDD
  readonly multiplier?: string;
  readonly description?: string;
  readonly localSymbol?: string;
}

export interface IbkrContractSearchResult {
  readonly conid: number;
  readonly symbol: string;
  readonly companyHeader?: string;
  readonly companyName?: string;
  readonly secType?: string;
  readonly description?: string;
  readonly issuers?: readonly { id: string; name: string }[];
  readonly sections?: readonly { secType: string; months?: string; exchange?: string }[];
}

// -- Orders --

export type IbkrOrderType = "MKT" | "LMT" | "STP" | "STOP_LIMIT" | "MIDPRICE" | "TRAIL" | "TRAIL_LIMIT";
export type IbkrSide = "BUY" | "SELL";
export type IbkrTif = "DAY" | "GTC" | "IOC" | "OPG" | "PAX";

export interface IbkrOrderRequest {
  readonly acctId: string;
  readonly conid: number;
  readonly orderType: IbkrOrderType;
  readonly side: IbkrSide;
  readonly tif: IbkrTif;
  readonly quantity: number;
  readonly price?: number;              // LMT and STOP_LIMIT
  readonly auxPrice?: number;           // STP, TRAIL, STOP_LIMIT
  readonly outsideRTH?: boolean;
  readonly listingExchange?: string;
  readonly cOID?: string;               // client order id (echoed back)
  readonly parentId?: string;           // for OCO / bracket
  readonly useAdaptive?: boolean;       // IBKR adaptive algo for better fills
  readonly isSingleGroup?: boolean;
}

// IBKR placeOrder requires { orders: [request] } envelope.
export interface IbkrPlaceOrderEnvelope {
  readonly orders: readonly IbkrOrderRequest[];
}

// IBKR sometimes returns a "reply" indicating a confirmation message must be
// echoed back before the order goes through. We handle these by auto-replying
// "true" once.
export interface IbkrOrderReply {
  readonly id: string;
  readonly message?: readonly string[];
  readonly isSuppressed?: boolean;
  readonly messageIds?: readonly string[];
}

export interface IbkrOrderPlaced {
  readonly order_id: string;
  readonly order_status?: string;
  readonly local_order_id?: string;
  readonly warning_message?: string;
}

export type IbkrPlaceOrderResponse = readonly (IbkrOrderReply | IbkrOrderPlaced)[];

export interface IbkrLiveOrder {
  readonly orderId: string;
  readonly status: string;              // PreSubmitted / Submitted / Filled / Cancelled / etc.
  readonly ticker?: string;
  readonly secType?: string;
  readonly conid?: number;
  readonly side?: string;
  readonly totalSize?: number;
  readonly filledQuantity?: number;
  readonly remainingQuantity?: number;
  readonly avgPrice?: string;
  readonly orderDesc?: string;
  readonly listingExchange?: string;
  readonly origOrderType?: string;
  readonly orderType?: string;
  readonly price?: string;
  readonly timeInForce?: string;
  readonly lastExecutionTime?: string;  // YYMMDDHHMMSS
  readonly lastExecutionTime_r?: number;
}

export interface IbkrLiveOrdersResponse {
  readonly orders: readonly IbkrLiveOrder[];
  readonly snapshot: boolean;
}

// -- Market data --

// IBKR uses positional field codes for snapshot data. Selected codes we use:
//   31  Last Price
//   55  Symbol
//   58  Text
//   70  Highest Price
//   71  Lowest Price
//   73  Market Value
//   74  Avg Price
//   75  Unrealized P&L
//   76  Formatted Position
//   77  Formatted Unrealized P&L
//   78  Daily P&L
//   79  Realized P&L
//   80  Unrealized P&L %
//   82  Change
//   83  Change %
//   84  Bid
//   85  Ask Size
//   86  Ask
//   87  Volume
//   88  Bid Size
//   200 Days to Expiration
//   201 Option Implied Volatility
//   ...
//
// We hit /iserver/marketdata/snapshot?conids=...&fields=31,84,86,87,...
// and read fields back from the response by code.

export interface IbkrMarketDataField {
  readonly conid: number;
  readonly server_id?: string;
  readonly _updated?: number;
  // Field values keyed by string code:
  readonly [fieldCode: string]: number | string | undefined;
}

// -- Historical data --

export interface IbkrHistoricalParams {
  readonly conid: number;
  readonly period: string;              // e.g. "1d", "5d", "1m" (one month), "1y"
  readonly bar: string;                 // e.g. "1min", "5min", "1h", "1d"
  readonly outsideRth?: boolean;
}

export interface IbkrHistoricalBar {
  readonly t: number;                   // Unix ms
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
}

export interface IbkrHistoricalResponse {
  readonly symbol: string;
  readonly text?: string;
  readonly priceFactor?: number;
  readonly startTime?: string;
  readonly high?: string;
  readonly low?: string;
  readonly timePeriod?: string;
  readonly barLength?: number;
  readonly mdAvailability?: string;
  readonly outsideRth?: boolean;
  readonly tradingDayDuration?: number;
  readonly volumeFactor?: number;
  readonly priceDisplayRule?: number;
  readonly priceDisplayValue?: string;
  readonly negativeCapable?: boolean;
  readonly messageVersion?: number;
  readonly data: readonly IbkrHistoricalBar[];
  readonly points: number;
  readonly travelTime?: number;
}

// -- Streaming WebSocket --

// Protocol: send JSON messages with topic-style strings.
//   { topic: "smd+<conid>", args: { fields: ["31","84","86",...] } }   subscribe market data
//   { topic: "umd+<conid>" }                                            unsubscribe market data
//   { topic: "sor", args: { ... } }                                     subscribe live orders
//   { topic: "spl+<accountId>" }                                        subscribe P&L
//
// Responses are JSON keyed by 'topic'. Live order events come as
//   { topic: "sor", args: [ ... live orders ... ] }
// Market data ticks come as
//   { topic: "smd+<conid>", "31": "456.78", "84": "456.77", ... }

export interface IbkrStreamRequest {
  readonly topic: string;
  readonly args?: Record<string, unknown>;
}

export interface IbkrStreamMessage {
  readonly topic?: string;
  readonly args?: unknown;
  readonly conid?: number;
  // Field values keyed by numeric strings
  readonly [k: string]: unknown;
}
