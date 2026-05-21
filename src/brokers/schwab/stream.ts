// Schwab streaming WebSocket client.
//
// Connection flow (verified):
//   1. REST: GET /trader/v1/userPreference -> streamerInfo[0] contains:
//        streamerSocketUrl   (wss://...)
//        schwabClientCustomerId
//        schwabClientCorrelId
//        schwabClientChannel
//        schwabClientFunctionId
//   2. Open WS to streamerSocketUrl
//   3. Send LOGIN frame:
//        {
//          requests: [{
//            service: "ADMIN",
//            command: "LOGIN",
//            requestid: "1",
//            SchwabClientCustomerId,
//            SchwabClientCorrelId,
//            parameters: {
//              Authorization: <access_token>,
//              SchwabClientChannel: <channel>,
//              SchwabClientFunctionId: <functionId>
//            }
//          }]
//        }
//   4. After LOGIN success (code 0), send SUBS frames per service.
//
// Services we use:
//   LEVELONE_EQUITIES  -- real-time equity quotes (subscribe by uppercase ticker)
//   LEVELONE_OPTIONS   -- real-time option quotes (subscribe by per-contract OSI symbol)
//   ACCT_ACTIVITY      -- order/fill push notifications (subscribe with the
//                         schwabClientCorrelId as the key)
//
// Reconnect behavior:
//   The underlying ws-manager handles exponential backoff. On reconnect, we
//   re-LOGIN and re-SUBS all previously requested keys.
//
// Heartbeat:
//   Schwab does not document a custom app-level heartbeat. We rely on the
//   protocol-level ping/pong handled by ws-manager.

import { WsManager } from "../../utils/ws-manager.js";
import { createLogger } from "../../core/logger.js";
import type { SchwabAuth } from "./auth.js";
import type { SchwabRest } from "./rest.js";
import type {
  SchwabStreamerInfo,
  SchwabStreamRequest,
  SchwabStreamRequestEnvelope,
  SchwabStreamResponse,
  SchwabStreamService,
} from "./types.js";

const log = createLogger("schwab-stream");

// Field sets per service. The numbers are positional field IDs from Schwab.
// Subset that we actually need; expand later as required.
//
// LEVELONE_EQUITIES (per Schwab docs):
//   0 symbol, 1 bid, 2 ask, 3 last, 4 bidSize, 5 askSize, 8 totalVolume,
//   33 lastSize, 35 quoteTime (ms), 36 tradeTime (ms), 38 mark
const EQUITY_FIELDS = "0,1,2,3,4,5,8,33,35,36,38";

// LEVELONE_OPTIONS:
//   0 symbol, 2 bid, 3 ask, 4 last, 5 highPrice, 6 lowPrice, 7 closePrice,
//   8 totalVolume, 9 openInterest, 10 volatility, 12 expirationYear,
//   13 multiplier, 16 strikePrice, 19 underlying, 20 deliverables,
//   28 delta, 29 gamma, 30 theta, 31 vega, 32 rho, 38 mark
const OPTION_FIELDS = "0,2,3,4,5,6,8,9,10,16,19,28,29,30,31,32,38";

// ACCT_ACTIVITY: keys are usually empty (correlId is the channel), fields are
// 0 subscription_key, 1 account, 2 messageType, 3 messageData
const ACCT_ACTIVITY_FIELDS = "0,1,2,3";

interface SubscriptionState {
  readonly service: SchwabStreamService;
  readonly fields: string;
  readonly keys: Set<string>;
}

type StreamDataHandler = (service: SchwabStreamService, content: readonly Record<string, unknown>[]) => void;

export class SchwabStream {
  private ws: WsManager | null = null;
  private streamerInfo: SchwabStreamerInfo | null = null;
  private loggedIn = false;
  private requestCounter = 0;
  private readonly subscriptions: Map<SchwabStreamService, SubscriptionState> = new Map();
  private dataHandler: StreamDataHandler | null = null;
  private loginResolvers: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  constructor(
    private readonly auth: SchwabAuth,
    private readonly rest: SchwabRest,
  ) {}

  setDataHandler(handler: StreamDataHandler): void {
    this.dataHandler = handler;
  }

  // Connect, login, and (re)subscribe to existing subscriptions.
  async start(): Promise<void> {
    if (!this.streamerInfo) {
      log.info("Fetching streamerInfo from userPreference");
      const pref = await this.rest.getUserPreference();
      this.streamerInfo = pref.streamerInfo[0];
    }

    this.ws = new WsManager({
      url: this.streamerInfo.streamerSocketUrl,
      name: "schwab-stream",
    });

    this.ws.setMessageHandler((raw) => this.handleMessage(raw));
    this.ws.setConnectedHandler(() => {
      this.loggedIn = false;
      this.loginAndResubscribe().catch((err) => {
        log.error("Login/resubscribe failed", { error: errMsg(err) });
      });
    });
    this.ws.setDisconnectedHandler(() => {
      this.loggedIn = false;
    });

    this.ws.connect();

    // Block start() until LOGIN completes (or fails).
    await new Promise<void>((resolve, reject) => {
      this.loginResolvers.push({ resolve, reject });
    });
  }

  stop(): void {
    this.loggedIn = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    // Reject any pending login waiters.
    for (const r of this.loginResolvers) r.reject(new Error("Stream stopped"));
    this.loginResolvers = [];
  }

  // Subscribe to additional equity symbols. Merges into existing subscription.
  subscribeEquities(symbols: readonly string[]): void {
    this.addSubscription("LEVELONE_EQUITIES", symbols, EQUITY_FIELDS);
  }

  // Subscribe to per-contract option symbols (OSI 21-char format).
  subscribeOptions(symbols: readonly string[]): void {
    this.addSubscription("LEVELONE_OPTIONS", symbols, OPTION_FIELDS);
  }

  // Subscribe to account-activity push (order/fill notifications).
  // Schwab keys this on the operator's correlId (passed via streamerInfo).
  subscribeAccountActivity(): void {
    if (!this.streamerInfo) {
      log.warn("Cannot subscribe ACCT_ACTIVITY before start() loads streamerInfo");
      return;
    }
    this.addSubscription("ACCT_ACTIVITY", [this.streamerInfo.schwabClientCorrelId], ACCT_ACTIVITY_FIELDS);
  }

  // Unsubscribe from specific keys within a service.
  unsubscribe(service: SchwabStreamService, keys: readonly string[]): void {
    const sub = this.subscriptions.get(service);
    if (!sub) return;
    const toRemove = keys.filter((k) => sub.keys.has(k));
    if (toRemove.length === 0) return;
    for (const k of toRemove) sub.keys.delete(k);
    if (this.loggedIn) {
      this.send({
        service,
        command: "UNSUBS",
        requestid: this.nextRequestId(),
        SchwabClientCustomerId: this.streamerInfo!.schwabClientCustomerId,
        SchwabClientCorrelId: this.streamerInfo!.schwabClientCorrelId,
        parameters: { keys: toRemove.join(",") },
      });
    }
  }

  // ----- Internals -----

  private addSubscription(
    service: SchwabStreamService,
    keys: readonly string[],
    fields: string,
  ): void {
    if (keys.length === 0) return;
    let sub = this.subscriptions.get(service);
    if (!sub) {
      sub = { service, fields, keys: new Set() };
      this.subscriptions.set(service, sub);
    }
    const newKeys: string[] = [];
    for (const k of keys) {
      if (!sub.keys.has(k)) {
        sub.keys.add(k);
        newKeys.push(k);
      }
    }
    if (newKeys.length === 0) return;
    if (this.loggedIn) {
      this.send({
        service,
        command: "ADD",
        requestid: this.nextRequestId(),
        SchwabClientCustomerId: this.streamerInfo!.schwabClientCustomerId,
        SchwabClientCorrelId: this.streamerInfo!.schwabClientCorrelId,
        parameters: { keys: newKeys.join(","), fields },
      });
    }
  }

  private async loginAndResubscribe(): Promise<void> {
    if (!this.streamerInfo) {
      throw new Error("loginAndResubscribe called without streamerInfo");
    }
    const token = await this.auth.getAccessToken();

    this.send({
      service: "ADMIN",
      command: "LOGIN",
      requestid: this.nextRequestId(),
      SchwabClientCustomerId: this.streamerInfo.schwabClientCustomerId,
      SchwabClientCorrelId: this.streamerInfo.schwabClientCorrelId,
      parameters: {
        Authorization: token,
        SchwabClientChannel: this.streamerInfo.schwabClientChannel,
        SchwabClientFunctionId: this.streamerInfo.schwabClientFunctionId,
      },
    });
    // Wait for the LOGIN response in handleMessage.
  }

  private sendInitialSubscriptions(): void {
    if (!this.streamerInfo) return;
    for (const sub of this.subscriptions.values()) {
      if (sub.keys.size === 0) continue;
      this.send({
        service: sub.service,
        command: "SUBS",
        requestid: this.nextRequestId(),
        SchwabClientCustomerId: this.streamerInfo.schwabClientCustomerId,
        SchwabClientCorrelId: this.streamerInfo.schwabClientCorrelId,
        parameters: {
          keys: Array.from(sub.keys).join(","),
          fields: sub.fields,
        },
      });
    }
  }

  private handleMessage(raw: unknown): void {
    const msg = raw as SchwabStreamResponse;

    if (msg.response) {
      for (const r of msg.response) {
        if (r.service === "ADMIN" && r.command === "LOGIN") {
          if (r.content.code === 0) {
            this.loggedIn = true;
            log.info("Streamer logged in");
            this.sendInitialSubscriptions();
            for (const w of this.loginResolvers) w.resolve();
            this.loginResolvers = [];
          } else {
            const err = new Error(`Streamer LOGIN failed: code=${r.content.code} msg=${r.content.msg}`);
            log.error("Streamer LOGIN failed", { code: r.content.code, msg: r.content.msg });
            for (const w of this.loginResolvers) w.reject(err);
            this.loginResolvers = [];
          }
        } else if (r.content.code !== 0) {
          log.warn("Streamer command failed", {
            service: r.service,
            command: r.command,
            code: r.content.code,
            msg: r.content.msg,
          });
        }
      }
    }

    if (msg.data && this.dataHandler) {
      for (const d of msg.data) {
        this.dataHandler(d.service as SchwabStreamService, d.content);
      }
    }

    if (msg.notify) {
      // Heartbeats and other notifications. Useful for liveness checks; we
      // currently rely on protocol pings instead.
      log.debug("Streamer notify", { count: msg.notify.length });
    }
  }

  private send(request: SchwabStreamRequest): void {
    if (!this.ws) return;
    const envelope: SchwabStreamRequestEnvelope = { requests: [request] };
    this.ws.send(envelope);
  }

  private nextRequestId(): string {
    return String(++this.requestCounter);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
