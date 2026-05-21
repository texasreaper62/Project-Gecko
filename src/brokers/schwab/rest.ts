// Schwab Trader API REST client.
//
// Base URLs (verified):
//   Trader:      https://api.schwabapi.com/trader/v1
//   Market Data: https://api.schwabapi.com/marketdata/v1
//
// Auth: Bearer token from SchwabAuth (auth.ts).
//
// Rate limits:
//   - Orders (POST/PUT/DELETE on /orders): 120 req/min/account.
//   - GET /orders: per Schwab, unthrottled.
//   - Market data: ~120 req/min ceiling (per third-party reports; not officially numerated).
//
// Design notes:
//   - Account hash, not raw account number, in every URL.
//   - All read endpoints retry on 5xx (via fetchWithRetry).
//   - Order placement endpoints do NOT retry (could place duplicates). They
//     surface the response body on failure so the caller can decide.
//   - All response shapes validated to the minimum required fields before return.

import { createLogger } from "../../core/logger.js";
import { fetchWithRetry } from "../../utils/retry.js";
import type { SchwabAuth } from "./auth.js";
import type {
  SchwabAccount,
  SchwabAccountNumberMap,
  SchwabOrderRequest,
  SchwabOrderResponse,
  SchwabOptionChain,
  SchwabPriceHistory,
  SchwabQuote,
  SchwabUserPreference,
} from "./types.js";

const log = createLogger("schwab-rest");

const TRADER_BASE = "https://api.schwabapi.com/trader/v1";
const MARKETDATA_BASE = "https://api.schwabapi.com/marketdata/v1";

// Single-attempt timeout for order placement (no retries — see header).
const ORDER_TIMEOUT_MS = 10_000;

export interface PriceHistoryParams {
  readonly symbol: string;
  readonly periodType?: "day" | "month" | "year" | "ytd";
  readonly period?: number;
  readonly frequencyType?: "minute" | "daily" | "weekly" | "monthly";
  readonly frequency?: number;
  readonly startDate?: number;        // Unix ms
  readonly endDate?: number;          // Unix ms
  readonly needExtendedHoursData?: boolean;
  readonly needPreviousClose?: boolean;
}

export interface OptionChainParams {
  readonly symbol: string;
  readonly contractType?: "CALL" | "PUT" | "ALL";
  readonly strikeCount?: number;
  readonly includeUnderlyingQuote?: boolean;
  readonly strategy?: "SINGLE" | "ANALYTICAL" | "COVERED" | "VERTICAL" | "CALENDAR" | "STRANGLE" | "STRADDLE" | "BUTTERFLY" | "CONDOR" | "DIAGONAL" | "COLLAR" | "ROLL";
  readonly fromDate?: string;         // YYYY-MM-DD
  readonly toDate?: string;           // YYYY-MM-DD
  readonly expMonth?: "ALL" | "JAN" | "FEB" | "MAR" | "APR" | "MAY" | "JUN" | "JUL" | "AUG" | "SEP" | "OCT" | "NOV" | "DEC";
  readonly optionType?: "S" | "NS" | "ALL";
}

export class SchwabRest {
  constructor(private readonly auth: SchwabAuth) {}

  // ----- Accounts -----

  // Returns {accountNumber, hashValue} pairs for all linked accounts.
  // Use the hashValue in every other call.
  async getAccountNumbers(): Promise<readonly SchwabAccountNumberMap[]> {
    const data = await this.get<unknown>(`${TRADER_BASE}/accounts/accountNumbers`);
    if (!Array.isArray(data)) {
      throw new Error(`accountNumbers: expected array, got ${typeof data}`);
    }
    return data.map((row) => {
      const r = row as Partial<SchwabAccountNumberMap>;
      if (typeof r.accountNumber !== "string" || typeof r.hashValue !== "string") {
        throw new Error(`accountNumbers: bad row shape: ${JSON.stringify(row)}`);
      }
      return { accountNumber: r.accountNumber, hashValue: r.hashValue };
    });
  }

  // Get an account by hash, optionally including positions.
  async getAccount(accountHash: string, includePositions = true): Promise<SchwabAccount> {
    const q = includePositions ? "?fields=positions" : "";
    const data = await this.get<unknown>(`${TRADER_BASE}/accounts/${accountHash}${q}`);
    const d = data as Partial<SchwabAccount>;
    if (!d.securitiesAccount || typeof d.securitiesAccount.accountNumber !== "string") {
      throw new Error(`getAccount: malformed response`);
    }
    return d as SchwabAccount;
  }

  // User preferences include the streamerInfo needed to connect the WS.
  async getUserPreference(): Promise<SchwabUserPreference> {
    const data = await this.get<unknown>(`${TRADER_BASE}/userPreference`);
    const d = data as Partial<SchwabUserPreference>;
    if (!Array.isArray(d.streamerInfo) || d.streamerInfo.length === 0) {
      throw new Error(`getUserPreference: streamerInfo missing or empty`);
    }
    const first = d.streamerInfo[0];
    if (
      typeof first.streamerSocketUrl !== "string" ||
      typeof first.schwabClientCustomerId !== "string" ||
      typeof first.schwabClientCorrelId !== "string" ||
      typeof first.schwabClientChannel !== "string" ||
      typeof first.schwabClientFunctionId !== "string"
    ) {
      throw new Error(`getUserPreference: streamerInfo missing required fields`);
    }
    return d as SchwabUserPreference;
  }

  // ----- Orders -----

  // Place an order. The order shape covers both equities and single-leg/
  // multi-leg options (differentiated by orderStrategyType + orderLegCollection).
  // Returns the orderId parsed from the Location header on 201.
  async placeOrder(accountHash: string, order: SchwabOrderRequest): Promise<{ orderId: string }> {
    const url = `${TRADER_BASE}/accounts/${accountHash}/orders`;
    const token = await this.auth.getAccessToken();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ORDER_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(order),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (resp.status !== 201) {
      const text = await resp.text().catch(() => "");
      throw new Error(`placeOrder: HTTP ${resp.status}: ${text.slice(0, 500)}`);
    }

    // Schwab returns the order id in the Location header: .../orders/{id}
    const loc = resp.headers.get("location") ?? resp.headers.get("Location") ?? "";
    const match = loc.match(/\/orders\/(\d+)/);
    if (!match) {
      throw new Error(`placeOrder: missing or unparseable Location header: ${loc}`);
    }
    log.info("Order placed", { orderId: match[1] });
    return { orderId: match[1] };
  }

  // Preview an order without submitting. Validates fields and projected impact.
  async previewOrder(accountHash: string, order: SchwabOrderRequest): Promise<unknown> {
    const url = `${TRADER_BASE}/accounts/${accountHash}/previewOrder`;
    return this.post<unknown>(url, order);
  }

  // Fetch a placed order by ID.
  async getOrder(accountHash: string, orderId: string): Promise<SchwabOrderResponse> {
    const data = await this.get<unknown>(`${TRADER_BASE}/accounts/${accountHash}/orders/${orderId}`);
    const d = data as Partial<SchwabOrderResponse>;
    if (typeof d.orderId !== "number" || typeof d.status !== "string") {
      throw new Error(`getOrder: malformed response`);
    }
    return d as SchwabOrderResponse;
  }

  // Cancel an open order.
  async cancelOrder(accountHash: string, orderId: string): Promise<void> {
    const url = `${TRADER_BASE}/accounts/${accountHash}/orders/${orderId}`;
    const token = await this.auth.getAccessToken();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ORDER_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (resp.status !== 200 && resp.status !== 204) {
      const text = await resp.text().catch(() => "");
      throw new Error(`cancelOrder: HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    log.info("Order cancelled", { orderId });
  }

  // List all orders for an account, optionally filtered by status and time range.
  async listOrders(
    accountHash: string,
    opts?: {
      readonly fromEnteredTime?: string;     // ISO timestamp
      readonly toEnteredTime?: string;       // ISO timestamp
      readonly maxResults?: number;
      readonly status?: string;
    },
  ): Promise<readonly SchwabOrderResponse[]> {
    const params = new URLSearchParams();
    if (opts?.fromEnteredTime) params.set("fromEnteredTime", opts.fromEnteredTime);
    if (opts?.toEnteredTime) params.set("toEnteredTime", opts.toEnteredTime);
    if (opts?.maxResults) params.set("maxResults", String(opts.maxResults));
    if (opts?.status) params.set("status", opts.status);
    const qs = params.toString();
    const url = `${TRADER_BASE}/accounts/${accountHash}/orders${qs ? `?${qs}` : ""}`;
    const data = await this.get<unknown>(url);
    if (!Array.isArray(data)) return [];
    return data as SchwabOrderResponse[];
  }

  // ----- Market data -----

  // Option chain for a single underlying. SPY 0DTE pull uses contractType=ALL,
  // fromDate=today, toDate=today, includeUnderlyingQuote=true.
  async getOptionChain(params: OptionChainParams): Promise<SchwabOptionChain> {
    const qs = new URLSearchParams();
    qs.set("symbol", params.symbol);
    if (params.contractType) qs.set("contractType", params.contractType);
    if (params.strikeCount !== undefined) qs.set("strikeCount", String(params.strikeCount));
    if (params.includeUnderlyingQuote !== undefined) qs.set("includeUnderlyingQuote", String(params.includeUnderlyingQuote));
    if (params.strategy) qs.set("strategy", params.strategy);
    if (params.fromDate) qs.set("fromDate", params.fromDate);
    if (params.toDate) qs.set("toDate", params.toDate);
    if (params.expMonth) qs.set("expMonth", params.expMonth);
    if (params.optionType) qs.set("optionType", params.optionType);

    const data = await this.get<unknown>(`${MARKETDATA_BASE}/chains?${qs.toString()}`);
    const d = data as Partial<SchwabOptionChain>;
    if (typeof d.symbol !== "string" || typeof d.status !== "string") {
      throw new Error(`getOptionChain: malformed response`);
    }
    return d as SchwabOptionChain;
  }

  // Historical bars. One symbol per call (per Schwab).
  // Defaults to 10 days of 5-minute bars; override for backtesting needs.
  async getPriceHistory(params: PriceHistoryParams): Promise<SchwabPriceHistory> {
    const qs = new URLSearchParams();
    qs.set("symbol", params.symbol);
    if (params.periodType) qs.set("periodType", params.periodType);
    if (params.period !== undefined) qs.set("period", String(params.period));
    if (params.frequencyType) qs.set("frequencyType", params.frequencyType);
    if (params.frequency !== undefined) qs.set("frequency", String(params.frequency));
    if (params.startDate !== undefined) qs.set("startDate", String(params.startDate));
    if (params.endDate !== undefined) qs.set("endDate", String(params.endDate));
    if (params.needExtendedHoursData !== undefined) qs.set("needExtendedHoursData", String(params.needExtendedHoursData));
    if (params.needPreviousClose !== undefined) qs.set("needPreviousClose", String(params.needPreviousClose));

    const data = await this.get<unknown>(`${MARKETDATA_BASE}/pricehistory?${qs.toString()}`);
    const d = data as Partial<SchwabPriceHistory>;
    if (typeof d.symbol !== "string" || !Array.isArray(d.candles)) {
      throw new Error(`getPriceHistory: malformed response`);
    }
    return d as SchwabPriceHistory;
  }

  // Get quotes for a list of symbols. Equity tickers or OSI option symbols.
  async getQuotes(symbols: readonly string[]): Promise<Record<string, SchwabQuote>> {
    if (symbols.length === 0) return {};
    const qs = new URLSearchParams({ symbols: symbols.join(",") });
    const data = await this.get<unknown>(`${MARKETDATA_BASE}/quotes?${qs.toString()}`);
    if (typeof data !== "object" || data === null) {
      throw new Error(`getQuotes: malformed response`);
    }
    return data as Record<string, SchwabQuote>;
  }

  // ----- Internals -----

  private async get<T>(url: string): Promise<T> {
    const token = await this.auth.getAccessToken();
    const resp = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return (await resp.json()) as T;
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const token = await this.auth.getAccessToken();
    const resp = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return (await resp.json()) as T;
  }
}
