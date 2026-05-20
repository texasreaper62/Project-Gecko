// Schwab Trader API request/response shapes.
// Verified against documentation research (see PR #2 description).
// Source endpoints documented in CLAUDE.md.
//
// Treat every shape here as the boundary contract with Schwab. If Schwab
// returns a field we did not expect, validate at read-time rather than
// trusting JSON.parse output blindly.

// -- OAuth --

export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly id_token?: string;
  readonly token_type: string;       // "Bearer"
  readonly scope?: string;
  readonly expires_in: number;       // seconds, 1800 = 30 min
}

export interface PersistedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: number;   // Unix ms
  readonly refreshTokenIssuedAt: number;   // Unix ms; full re-auth required after +7 days
}

// -- Accounts --

export interface SchwabAccountNumberMap {
  readonly accountNumber: string;
  readonly hashValue: string;
}

export interface SchwabBalances {
  readonly cashBalance?: number;
  readonly cashAvailableForTrading?: number;
  readonly buyingPower?: number;
  readonly dayTradingBuyingPower?: number;
  readonly liquidationValue?: number;
  readonly equity?: number;
  readonly accruedInterest?: number;
  readonly availableFunds?: number;
  readonly availableFundsNonMarginableTrade?: number;
  readonly maintenanceRequirement?: number;
}

export interface SchwabAccount {
  readonly securitiesAccount: {
    readonly accountNumber: string;
    readonly type: string;
    readonly roundTrips?: number;
    readonly isDayTrader?: boolean;
    readonly isClosingOnlyRestricted?: boolean;
    readonly initialBalances?: SchwabBalances;
    readonly currentBalances?: SchwabBalances;
    readonly projectedBalances?: SchwabBalances;
    readonly positions?: readonly SchwabPosition[];
  };
}

export interface SchwabPosition {
  readonly instrument: SchwabInstrument;
  readonly longQuantity: number;
  readonly shortQuantity: number;
  readonly averagePrice: number;
  readonly marketValue: number;
  readonly currentDayProfitLoss: number;
  readonly currentDayProfitLossPercentage: number;
}

export interface SchwabInstrument {
  readonly assetType: "EQUITY" | "OPTION" | "ETF" | "MUTUAL_FUND" | "CASH_EQUIVALENT" | "FIXED_INCOME" | "CURRENCY" | "INDEX";
  readonly symbol: string;
  readonly cusip?: string;
  readonly description?: string;
}

// -- Orders --

export type SchwabSession = "NORMAL" | "AM" | "PM" | "SEAMLESS";
export type SchwabDuration = "DAY" | "GOOD_TILL_CANCEL" | "FILL_OR_KILL" | "IMMEDIATE_OR_CANCEL" | "WEEK" | "MONTH" | "END_OF_WEEK" | "END_OF_MONTH" | "NEXT_END_OF_MONTH";
export type SchwabOrderType = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" | "TRAILING_STOP" | "CABINET" | "NON_MARKETABLE" | "MARKET_ON_CLOSE" | "EXERCISE" | "TRAILING_STOP_LIMIT" | "NET_DEBIT" | "NET_CREDIT" | "NET_ZERO";
export type SchwabOrderStrategyType = "SINGLE" | "OCO" | "TRIGGER";
export type SchwabComplexOrderStrategyType = "NONE" | "COVERED" | "VERTICAL" | "BACK_RATIO" | "CALENDAR" | "DIAGONAL" | "STRADDLE" | "STRANGLE" | "COLLAR_SYNTHETIC" | "BUTTERFLY" | "CONDOR" | "IRON_CONDOR" | "VERTICAL_ROLL" | "COLLAR_WITH_STOCK" | "DOUBLE_DIAGONAL" | "UNBALANCED_BUTTERFLY" | "UNBALANCED_CONDOR" | "UNBALANCED_IRON_CONDOR" | "UNBALANCED_VERTICAL_ROLL" | "CUSTOM";
export type SchwabInstruction = "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT" | "BUY_TO_OPEN" | "BUY_TO_CLOSE" | "SELL_TO_OPEN" | "SELL_TO_CLOSE" | "EXCHANGE";
export type SchwabOrderStatus = "AWAITING_PARENT_ORDER" | "AWAITING_CONDITION" | "AWAITING_STOP_CONDITION" | "AWAITING_MANUAL_REVIEW" | "ACCEPTED" | "AWAITING_UR_OUT" | "PENDING_ACTIVATION" | "QUEUED" | "WORKING" | "REJECTED" | "PENDING_CANCEL" | "CANCELED" | "PENDING_REPLACE" | "REPLACED" | "FILLED" | "EXPIRED" | "NEW" | "AWAITING_RELEASE_TIME" | "PENDING_ACKNOWLEDGEMENT" | "PENDING_RECALL" | "UNKNOWN";

export interface SchwabOrderLeg {
  readonly instruction: SchwabInstruction;
  readonly quantity: number;
  readonly instrument: {
    readonly symbol: string;
    readonly assetType: SchwabInstrument["assetType"];
  };
  readonly orderLegType?: "EQUITY" | "OPTION";
  readonly legId?: number;
  readonly positionEffect?: "OPENING" | "CLOSING" | "AUTOMATIC";
  readonly quantityType?: "ALL_SHARES" | "DOLLARS" | "SHARES";
}

export interface SchwabOrderRequest {
  readonly session: SchwabSession;
  readonly duration: SchwabDuration;
  readonly orderType: SchwabOrderType;
  readonly orderStrategyType: SchwabOrderStrategyType;
  readonly complexOrderStrategyType?: SchwabComplexOrderStrategyType;
  readonly price?: number;
  readonly stopPrice?: number;
  readonly orderLegCollection: readonly SchwabOrderLeg[];
}

export interface SchwabOrderResponse {
  readonly orderId: number;
  readonly status: SchwabOrderStatus;
  readonly enteredTime: string;
  readonly closeTime?: string;
  readonly filledQuantity?: number;
  readonly remainingQuantity?: number;
  readonly orderActivityCollection?: readonly SchwabOrderActivity[];
}

export interface SchwabOrderActivity {
  readonly activityType: "EXECUTION" | "ORDER_ACTION";
  readonly executionType?: "FILL";
  readonly quantity: number;
  readonly orderRemainingQuantity?: number;
  readonly executionLegs?: readonly {
    readonly legId: number;
    readonly price: number;
    readonly quantity: number;
    readonly mismarkedQuantity?: number;
    readonly instrumentId?: number;
    readonly time?: string;
  }[];
}

// -- Option chains --

export interface SchwabOptionContract {
  readonly putCall: "PUT" | "CALL";
  readonly symbol: string;          // OSI 21-char symbol
  readonly description: string;
  readonly bid: number;
  readonly ask: number;
  readonly last: number;
  readonly mark: number;
  readonly bidSize: number;
  readonly askSize: number;
  readonly totalVolume: number;
  readonly openInterest: number;
  readonly volatility: number;      // IV %
  readonly delta: number;
  readonly gamma: number;
  readonly theta: number;
  readonly vega: number;
  readonly rho: number;
  readonly strikePrice: number;
  readonly expirationDate: string;
  readonly daysToExpiration: number;
  readonly inTheMoney: boolean;
}

export interface SchwabOptionChain {
  readonly symbol: string;
  readonly status: string;
  readonly underlying?: {
    readonly symbol: string;
    readonly last: number;
    readonly bid: number;
    readonly ask: number;
  };
  readonly strategy: string;
  readonly interval: number;
  readonly isDelayed: boolean;
  readonly isIndex: boolean;
  readonly numberOfContracts: number;
  // Map keyed by expiration date string "YYYY-MM-DD:DTE", value keyed by strike "$strike"
  // and each strike maps to an array of contracts (single element for most strikes).
  readonly callExpDateMap: Record<string, Record<string, readonly SchwabOptionContract[]>>;
  readonly putExpDateMap: Record<string, Record<string, readonly SchwabOptionContract[]>>;
}

// -- Historical bars --

export interface SchwabPriceCandle {
  readonly datetime: number;        // Unix ms
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface SchwabPriceHistory {
  readonly symbol: string;
  readonly empty: boolean;
  readonly candles: readonly SchwabPriceCandle[];
}

// -- Quotes --

export interface SchwabQuote {
  readonly assetMainType: "EQUITY" | "OPTION" | "INDEX" | "MUTUAL_FUND";
  readonly symbol: string;
  readonly quoteType?: string;
  readonly quote: {
    readonly bidPrice: number;
    readonly bidSize: number;
    readonly askPrice: number;
    readonly askSize: number;
    readonly lastPrice: number;
    readonly lastSize: number;
    readonly mark?: number;
    readonly totalVolume?: number;
    readonly tradeTime?: number;
    readonly quoteTime?: number;
  };
}

// -- User Preference / streamer info --

export interface SchwabStreamerInfo {
  readonly streamerSocketUrl: string;
  readonly schwabClientCustomerId: string;
  readonly schwabClientCorrelId: string;
  readonly schwabClientChannel: string;
  readonly schwabClientFunctionId: string;
}

export interface SchwabUserPreference {
  readonly accounts: readonly {
    readonly accountNumber: string;
    readonly primaryAccount: boolean;
    readonly type: string;
    readonly nickName?: string;
    readonly displayAcctId?: string;
  }[];
  readonly streamerInfo: readonly SchwabStreamerInfo[];
}

// -- Streaming protocol --

export type SchwabStreamService =
  | "ADMIN"
  | "LEVELONE_EQUITIES"
  | "LEVELONE_OPTIONS"
  | "LEVELONE_FUTURES"
  | "LEVELONE_FOREX"
  | "CHART_EQUITY"
  | "CHART_FUTURES"
  | "ACCT_ACTIVITY"
  | "SCREENER_EQUITY"
  | "SCREENER_OPTION";

export type SchwabStreamCommand = "LOGIN" | "LOGOUT" | "SUBS" | "UNSUBS" | "ADD" | "VIEW";

export interface SchwabStreamRequest {
  readonly service: SchwabStreamService;
  readonly command: SchwabStreamCommand;
  readonly requestid: string;        // client-generated, echoed in response
  readonly SchwabClientCustomerId: string;
  readonly SchwabClientCorrelId: string;
  readonly parameters?: Record<string, string>;
}

export interface SchwabStreamRequestEnvelope {
  readonly requests: readonly SchwabStreamRequest[];
}

export interface SchwabStreamResponse {
  readonly response?: readonly {
    readonly service: string;
    readonly command: string;
    readonly requestid: string;
    readonly SchwabClientCorrelId?: string;
    readonly timestamp: number;
    readonly content: {
      readonly code: number;         // 0 = ok
      readonly msg: string;
    };
  }[];
  readonly data?: readonly {
    readonly service: string;
    readonly timestamp: number;
    readonly command: string;
    readonly content: readonly Record<string, unknown>[];
  }[];
  readonly notify?: readonly Record<string, unknown>[];
}
