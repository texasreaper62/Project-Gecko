import WebSocket from "ws";
import { createLogger } from "../core/logger.js";
import type { WsManagerConfig, FeedHealth, FeedStatus } from "../core/types.js";

const DEFAULT_PING_INTERVAL = 30_000;
const DEFAULT_PONG_TIMEOUT = 10_000;
const DEFAULT_INITIAL_RECONNECT_DELAY = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY = 60_000;

export type MessageHandler = (data: unknown) => void;

export class WsManager {
  private readonly config: Required<WsManagerConfig>;
  private readonly log;

  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private reconnectCount = 0;
  private lastMessageTime = 0;
  private status: FeedStatus = "disconnected";
  private lastError: string | null = null;
  private intentionallyClosed = false;

  private onMessage: MessageHandler | null = null;
  private onConnected: (() => void) | null = null;
  private onDisconnected: (() => void) | null = null;

  constructor(config: WsManagerConfig) {
    this.config = {
      url: config.url,
      name: config.name,
      pingInterval: config.pingInterval ?? DEFAULT_PING_INTERVAL,
      pongTimeout: config.pongTimeout ?? DEFAULT_PONG_TIMEOUT,
      maxReconnectDelay: config.maxReconnectDelay ?? DEFAULT_MAX_RECONNECT_DELAY,
      initialReconnectDelay: config.initialReconnectDelay ?? DEFAULT_INITIAL_RECONNECT_DELAY,
    };
    this.reconnectDelay = this.config.initialReconnectDelay;
    this.log = createLogger(this.config.name);
  }

  setMessageHandler(handler: MessageHandler): void {
    this.onMessage = handler;
  }

  setConnectedHandler(handler: () => void): void {
    this.onConnected = handler;
  }

  setDisconnectedHandler(handler: () => void): void {
    this.onDisconnected = handler;
  }

  connect(): void {
    if (this.ws) {
      this.cleanup();
      this.ws.removeAllListeners();
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }

    this.intentionallyClosed = false;
    this.status = "connecting";
    this.log.info("Connecting", { url: this.config.url });

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.config.url);
    } catch (err) {
      this.log.error("Failed to create WebSocket", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    this.ws.on("open", () => {
      this.status = "connected";
      this.reconnectDelay = this.config.initialReconnectDelay;
      this.lastMessageTime = Date.now();
      this.log.info("Connected", { reconnectCount: this.reconnectCount });
      this.startPing();
      this.onConnected?.();
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      this.lastMessageTime = Date.now();
      try {
        const data: unknown = JSON.parse(raw.toString());
        this.onMessage?.(data);
      } catch (err) {
        this.log.warn("Failed to parse message", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    this.ws.on("pong", () => {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      this.log.warn("Connection closed", {
        code,
        reason: reason.toString(),
      });
      this.status = "disconnected";
      this.cleanup();
      this.onDisconnected?.();
      if (!this.intentionallyClosed) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err: Error) => {
      this.lastError = err.message;
      this.log.error("WebSocket error", { error: err.message });
      this.status = "error";
      // 'close' event will follow, which triggers reconnect
    });
  }

  send(data: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.warn("Cannot send, WebSocket not open");
      return;
    }
    this.ws.send(JSON.stringify(data));
  }

  sendRaw(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.warn("Cannot send, WebSocket not open");
      return;
    }
    this.ws.send(data);
  }

  close(): void {
    this.intentionallyClosed = true;
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.status = "disconnected";
    this.log.info("Closed intentionally");
  }

  getHealth(): FeedHealth {
    return {
      name: this.config.name,
      status: this.status,
      lastMessage: this.lastMessageTime,
      reconnectCount: this.reconnectCount,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  getStatus(): FeedStatus {
    return this.status;
  }

  getLastMessageTime(): number {
    return this.lastMessageTime;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this.pongTimer = setTimeout(() => {
          this.log.warn("Pong timeout, reconnecting");
          this.pongTimer = null;
          this.stopPing();
          this.ws?.terminate();
        }, this.config.pongTimeout);
      }
    }, this.config.pingInterval);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectCount++;
    this.log.info(`Reconnecting in ${this.reconnectDelay}ms`, {
      attempt: this.reconnectCount,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.config.maxReconnectDelay,
    );
  }

  private cleanup(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
