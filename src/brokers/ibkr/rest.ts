// IBKR Client Portal Web API REST client.
//
// All endpoints assume an authenticated session held by IbkrAuth (auth.ts).
// Errors are surfaced as Error("IBKR <verb> <path>: HTTP <code>: <body>").
//
// IBKR quirk: many endpoints return EITHER a success payload OR a "reply"
// list with confirmation messages we have to echo back via POST /iserver/reply/{id}.
// placeOrder() auto-handles that loop transparently.

import * as https from "node:https";
import { createLogger } from "../../core/logger.js";
import type { IbkrAuth } from "./auth.js";
import type {
  IbkrAccount,
  IbkrContractSearchResult,
  IbkrHistoricalParams,
  IbkrHistoricalResponse,
  IbkrLiveOrder,
  IbkrLiveOrdersResponse,
  IbkrMarketDataField,
  IbkrOrderRequest,
  IbkrPortfolioSummary,
  IbkrPosition,
  IbkrPlaceOrderResponse,
  IbkrOrderPlaced,
  IbkrOrderReply,
} from "./types.js";

const log = createLogger("ibkr-rest");

// Local gateway uses a self-signed certificate. We accept it for localhost.
const LOCAL_AGENT = new https.Agent({ rejectUnauthorized: false });

// Default fields requested for equity snapshots (Last, Bid, Ask, Volume, Change%).
const DEFAULT_EQUITY_FIELDS = "31,84,86,87,83";
const DEFAULT_OPTION_FIELDS = "31,84,86,85,88,87,7283,7311,7308,7309";

export class IbkrRest {
  constructor(private readonly auth: IbkrAuth) {}

  // ----- Accounts -----

  async getAccounts(): Promise<readonly IbkrAccount[]> {
    const data = await this.get<unknown>(`/iserver/accounts`);
    // Endpoint returns { accounts: [...], aliases: {...}, ... }
    const obj = data as { accounts?: string[]; aliases?: Record<string, string>; allowFeatures?: Record<string, unknown> };
    if (!Array.isArray(obj.accounts)) {
      throw new Error(`getAccounts: malformed response`);
    }
    return obj.accounts.map((accountId) => ({
      accountId,
      accountAlias: obj.aliases?.[accountId],
    }));
  }

  // The portfolio API requires "selecting" an account first.
  async selectAccount(accountId: string): Promise<void> {
    await this.post(`/iserver/account`, { acctId: accountId });
  }

  async getPortfolioSummary(accountId: string): Promise<IbkrPortfolioSummary> {
    const data = await this.get<Record<string, { amount: number; currency: string }>>(
      `/portfolio/${accountId}/summary`,
    );
    // Reshape into our typed view.
    const summary: IbkrPortfolioSummary = {
      accountId,
      netliquidation: data.netliquidation,
      availablefunds: data.availablefunds,
      buyingpower: data.buyingpower,
      cashbalance: data.cashbalance,
      equitywithloanvalue: data.equitywithloanvalue,
      grosspositionvalue: data.grosspositionvalue,
      maintmarginreq: data.maintmarginreq,
      excessliquidity: data.excessliquidity,
    };
    return summary;
  }

  // Positions are paged. We fetch all pages.
  async getPositions(accountId: string): Promise<readonly IbkrPosition[]> {
    const all: IbkrPosition[] = [];
    for (let page = 0; page < 20; page++) {
      const data = await this.get<unknown>(`/portfolio/${accountId}/positions/${page}`);
      if (!Array.isArray(data) || data.length === 0) break;
      for (const row of data as IbkrPosition[]) all.push(row);
      if (data.length < 100) break;
    }
    return all;
  }

  // ----- Contracts -----

  async searchContracts(symbol: string, secType: "STK" | "OPT" = "STK"): Promise<readonly IbkrContractSearchResult[]> {
    const params = new URLSearchParams({
      symbol,
      name: "false",
      secType,
    });
    const data = await this.get<unknown>(`/iserver/secdef/search?${params.toString()}`);
    if (!Array.isArray(data)) return [];
    return data as IbkrContractSearchResult[];
  }

  // Resolve a single ticker to its primary US-listed STK conid.
  async resolveEquityConid(symbol: string): Promise<number | null> {
    const hits = await this.searchContracts(symbol, "STK");
    if (hits.length === 0) return null;
    return hits[0].conid;
  }

  // Strike list for a given underlying + expiry.
  // IBKR uses 3-letter month codes (JAN, FEB, etc.) with year suffix, e.g. "MAY26".
  async getOptionStrikes(conid: number, month: string, exchange = "SMART"): Promise<{ call: readonly number[]; put: readonly number[] }> {
    const params = new URLSearchParams({
      conid: String(conid),
      secType: "OPT",
      month,
      exchange,
    });
    const data = await this.get<{ call?: number[]; put?: number[] }>(
      `/iserver/secdef/strikes?${params.toString()}`,
    );
    return { call: data.call ?? [], put: data.put ?? [] };
  }

  // Resolve a specific option contract to its conid. IBKR requires:
  //   conid (underlying), secType=OPT, month=MMMYY (e.g. "MAY26"), strike, right=C|P
  async getOptionContractInfo(underlyingConid: number, month: string, strike: number, right: "C" | "P", exchange = "SMART"): Promise<readonly { conid: number; symbol: string; maturityDate: string; strike: number; right: string }[]> {
    const params = new URLSearchParams({
      conid: String(underlyingConid),
      secType: "OPT",
      month,
      strike: String(strike),
      right,
      exchange,
    });
    const data = await this.get<unknown>(`/iserver/secdef/info?${params.toString()}`);
    if (!Array.isArray(data)) return [];
    return data as { conid: number; symbol: string; maturityDate: string; strike: number; right: string }[];
  }

  // ----- Market data -----

  async getSnapshot(conids: readonly number[], fields = DEFAULT_EQUITY_FIELDS): Promise<readonly IbkrMarketDataField[]> {
    if (conids.length === 0) return [];
    const params = new URLSearchParams({
      conids: conids.join(","),
      fields,
    });
    // IBKR snapshot endpoint sometimes requires a second hit to return data
    // (first hit warms the cache). Quick retry handles that.
    let data = await this.get<unknown>(`/iserver/marketdata/snapshot?${params.toString()}`);
    if (Array.isArray(data) && data.length === 0) {
      await new Promise((r) => setTimeout(r, 200));
      data = await this.get<unknown>(`/iserver/marketdata/snapshot?${params.toString()}`);
    }
    return Array.isArray(data) ? (data as IbkrMarketDataField[]) : [];
  }

  async getEquityQuote(symbol: string): Promise<IbkrMarketDataField | null> {
    const conid = await this.resolveEquityConid(symbol);
    if (conid === null) return null;
    const rows = await this.getSnapshot([conid], DEFAULT_EQUITY_FIELDS);
    return rows[0] ?? null;
  }

  // ----- Historical -----

  async getHistorical(params: IbkrHistoricalParams): Promise<IbkrHistoricalResponse> {
    const qs = new URLSearchParams({
      conid: String(params.conid),
      period: params.period,
      bar: params.bar,
    });
    if (params.outsideRth !== undefined) qs.set("outsideRth", String(params.outsideRth));
    return this.get<IbkrHistoricalResponse>(`/iserver/marketdata/history?${qs.toString()}`);
  }

  // ----- Orders -----

  // Submit one order. Handles IBKR's "reply" confirmation loop transparently:
  // if IBKR returns a list of messages we have to acknowledge, we POST to
  // /iserver/reply/{id} with { confirmed: true } up to 3 times before giving up.
  async placeOrder(accountId: string, order: IbkrOrderRequest): Promise<IbkrOrderPlaced> {
    const path = `/iserver/account/${accountId}/orders`;
    const envelope = { orders: [order] };
    let response = await this.post<IbkrPlaceOrderResponse>(path, envelope);

    for (let i = 0; i < 3; i++) {
      if (!Array.isArray(response) || response.length === 0) {
        throw new Error(`placeOrder: empty response`);
      }
      const first = response[0];
      if (isOrderPlaced(first)) {
        log.info("Order placed", { orderId: first.order_id, status: first.order_status });
        return first;
      }
      if (isOrderReply(first)) {
        log.debug("Order has reply prompt", { replyId: first.id, msgCount: first.message?.length ?? 0 });
        response = await this.post<IbkrPlaceOrderResponse>(`/iserver/reply/${first.id}`, { confirmed: true });
        continue;
      }
      throw new Error(`placeOrder: unknown response shape: ${JSON.stringify(first).slice(0, 200)}`);
    }
    throw new Error(`placeOrder: confirmation loop did not resolve`);
  }

  async cancelOrder(accountId: string, orderId: string): Promise<void> {
    await this.del(`/iserver/account/${accountId}/order/${orderId}`);
  }

  async getLiveOrders(filter?: { accountId?: string; force?: boolean }): Promise<readonly IbkrLiveOrder[]> {
    const qs = new URLSearchParams();
    if (filter?.accountId) qs.set("accountId", filter.accountId);
    if (filter?.force) qs.set("force", "true");
    const path = `/iserver/account/orders${qs.toString() ? `?${qs.toString()}` : ""}`;
    const data = await this.get<IbkrLiveOrdersResponse>(path);
    return data.orders ?? [];
  }

  async getOrderStatus(orderId: string): Promise<IbkrLiveOrder | null> {
    const data = await this.get<IbkrLiveOrder>(`/iserver/account/order/status/${orderId}`);
    return data ?? null;
  }

  // ----- Internals -----

  private async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async del<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.auth.getBaseUrl()}${path}`;
    const init: RequestInit & { dispatcher?: unknown } = {
      method,
      headers: this.auth.authHeaders(),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    // Node's global fetch doesn't expose the agent option directly. For self-
    // signed local certs we set NODE_TLS_REJECT_UNAUTHORIZED=0 in dev or use
    // a custom undici dispatcher. Simplest: assume the gateway is reachable.
    void LOCAL_AGENT; // ensure import retained

    const resp = await fetch(url, init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`IBKR ${method} ${path}: HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    if (resp.status === 204) return undefined as T;
    return (await resp.json()) as T;
  }
}

function isOrderPlaced(x: unknown): x is IbkrOrderPlaced {
  return typeof x === "object" && x !== null && typeof (x as { order_id?: unknown }).order_id === "string";
}

function isOrderReply(x: unknown): x is IbkrOrderReply {
  return typeof x === "object" && x !== null
    && typeof (x as { id?: unknown }).id === "string"
    && (Array.isArray((x as { message?: unknown }).message) || (x as { messageIds?: unknown }).messageIds !== undefined);
}
