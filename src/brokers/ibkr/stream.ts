// IBKR Client Portal WebSocket client.
//
// URL: wss://<gateway-host>:<port>/v1/api/ws
//
// After socket open, IBKR requires an auth frame with the current session
// token: { session: "<sessionToken>" }. After that we send topic-based
// subscriptions:
//
//   smd+<conid>+{"fields":[...]}   subscribe market data for a contract
//   umd+<conid>                    unsubscribe market data
//   sor+{}                         subscribe to live order events
//   uor+{}                         unsubscribe from live orders
//   spl+                           subscribe to P&L
//   tic                            tickle / heartbeat
//
// Server messages arrive keyed by `topic`. We dispatch to the registered
// handler.

import { WsManager } from "../../utils/ws-manager.js";
import { createLogger } from "../../core/logger.js";
import type { IbkrAuth } from "./auth.js";
import type { IbkrStreamMessage } from "./types.js";

const log = createLogger("ibkr-stream");

const DEFAULT_EQUITY_FIELDS = ["31", "84", "86", "87", "83"];
const DEFAULT_OPTION_FIELDS = ["31", "84", "86", "85", "88", "87", "7283", "7311", "7308", "7309"];

export type IbkrStreamHandler = (topic: string, message: IbkrStreamMessage) => void;

interface MdSub {
  readonly conid: number;
  readonly kind: "equity" | "option";
  readonly fields: readonly string[];
}

export class IbkrStream {
  private ws: WsManager | null = null;
  private handler: IbkrStreamHandler | null = null;
  private readonly mdSubs: Map<number, MdSub> = new Map();
  private liveOrdersSubscribed = false;
  private authed = false;
  private authResolvers: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  constructor(private readonly auth: IbkrAuth, private readonly baseUrl: string) {}

  setHandler(h: IbkrStreamHandler): void {
    this.handler = h;
  }

  async start(): Promise<void> {
    // Convert https:// gateway URL to wss://, point at /ws.
    const wsUrl = this.baseUrl
      .replace(/^http(s?):\/\//, (_m, s) => `ws${s ? "s" : ""}://`)
      .replace(/\/v1\/api\/?$/, "") + "/v1/api/ws";

    this.ws = new WsManager({ url: wsUrl, name: "ibkr-stream" });
    this.ws.setMessageHandler((raw) => this.onMessage(raw));
    this.ws.setConnectedHandler(() => {
      this.authed = false;
      this.sendAuth();
    });
    this.ws.setDisconnectedHandler(() => {
      this.authed = false;
    });
    this.ws.connect();

    await new Promise<void>((resolve, reject) => {
      this.authResolvers.push({ resolve, reject });
      setTimeout(() => reject(new Error("IBKR stream auth timeout")), 10_000);
    });
  }

  stop(): void {
    this.authed = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const r of this.authResolvers) r.reject(new Error("Stream stopped"));
    this.authResolvers = [];
  }

  subscribeEquity(conid: number): void {
    this.addMd(conid, "equity", DEFAULT_EQUITY_FIELDS);
  }

  subscribeOption(conid: number): void {
    this.addMd(conid, "option", DEFAULT_OPTION_FIELDS);
  }

  unsubscribeMd(conid: number): void {
    if (!this.mdSubs.has(conid)) return;
    this.mdSubs.delete(conid);
    if (this.authed) this.sendRaw(`umd+${conid}+{}`);
  }

  subscribeLiveOrders(): void {
    if (this.liveOrdersSubscribed) return;
    this.liveOrdersSubscribed = true;
    if (this.authed) this.sendRaw(`sor+{}`);
  }

  // ----- Internals -----

  private addMd(conid: number, kind: "equity" | "option", fields: readonly string[]): void {
    if (this.mdSubs.has(conid)) return;
    this.mdSubs.set(conid, { conid, kind, fields });
    if (this.authed) this.sendMd(conid, fields);
  }

  private sendAuth(): void {
    if (!this.ws) return;
    const sessionCookie = this.auth.authHeaders().Cookie ?? "";
    const sessionToken = sessionCookie.replace(/^api=/, "");
    if (!sessionToken) {
      log.error("Cannot auth stream: no session token");
      return;
    }
    this.ws.send({ session: sessionToken });
  }

  private sendMd(conid: number, fields: readonly string[]): void {
    if (!this.ws) return;
    const payload = `smd+${conid}+${JSON.stringify({ fields })}`;
    this.sendRaw(payload);
  }

  private sendRaw(msg: string): void {
    if (!this.ws) return;
    this.ws.sendRaw(msg);
  }

  private resendSubscriptions(): void {
    for (const sub of this.mdSubs.values()) {
      this.sendMd(sub.conid, sub.fields);
    }
    if (this.liveOrdersSubscribed) this.sendRaw(`sor+{}`);
  }

  private onMessage(raw: unknown): void {
    // IBKR sends both JSON objects and structured strings depending on topic.
    const msg = raw as IbkrStreamMessage;
    const topic = typeof msg?.topic === "string" ? msg.topic : "";

    // Auth ack — IBKR replies with topic "system" and message "Authenticated"
    if (!this.authed) {
      if (typeof msg === "object" && msg !== null) {
        const hello = msg as { topic?: string; message?: string; success?: unknown };
        if (hello.topic === "system" && typeof hello.message === "string" && /[Aa]uthenticated/.test(hello.message)) {
          this.authed = true;
          log.info("IBKR stream authenticated");
          this.resendSubscriptions();
          for (const r of this.authResolvers) r.resolve();
          this.authResolvers = [];
          return;
        }
        // Some gateway versions just emit a session ack on connect.
        if (hello.success !== undefined) {
          this.authed = true;
          log.info("IBKR stream session ack");
          this.resendSubscriptions();
          for (const r of this.authResolvers) r.resolve();
          this.authResolvers = [];
          return;
        }
      }
    }

    if (this.handler && topic) {
      try {
        this.handler(topic, msg);
      } catch (err) {
        log.error("Stream handler threw", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
