// IBKR Client Portal Web API session management.
//
// Two operating models supported:
//
//   1. Local gateway (default). The user runs clientportal.gw on the same
//      machine (or via Docker). It listens on https://localhost:5000 by
//      default. Authentication is interactive: browse to the gateway URL,
//      log in via the IBKR login screen, the gateway holds the session.
//      Our job is to keep the session alive by hitting /tickle every ~60s.
//
//   2. OAuth 2.0 hosted gateway. IBKR's newer flow lets us POST to obtain
//      a bearer token + session cookie via a server-to-server call. Same
//      /tickle keepalive applies.
//
// Either way, the resulting auth state we hold is:
//   - baseUrl: where the API lives
//   - sessionCookie: api=<session_token>
//   - lastAuthCheckAt: timestamp for staleness
//
// Sessions die after ~6 minutes of inactivity. We tickle every 60 seconds.

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../../core/logger.js";
import type { IbkrAuthStatus, IbkrTickleResponse, PersistedIbkrTokens } from "./types.js";

const log = createLogger("ibkr-auth");

const DEFAULT_BASE_URL = "https://localhost:5000/v1/api";
const TICKLE_INTERVAL_MS = 60 * 1000;           // hit /tickle every minute
const AUTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;   // verify /iserver/auth/status every 5 min
const TOKEN_FILE = "data/ibkr-tokens.json";

export interface IbkrAuthConfig {
  readonly baseUrl: string;                     // e.g. https://localhost:5000/v1/api
  readonly rejectUnauthorized?: boolean;        // for self-signed local cert
  readonly oauthClientId?: string;              // optional OAuth flow
  readonly oauthClientSecret?: string;
}

export class IbkrAuth {
  private sessionCookie: string | null = null;
  private accessToken: string | null = null;
  private tickleTimer: ReturnType<typeof setInterval> | null = null;
  private authCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastAuthOk = false;
  private lastTickleAt = 0;

  constructor(private readonly config: IbkrAuthConfig) {}

  getBaseUrl(): string {
    return this.config.baseUrl || DEFAULT_BASE_URL;
  }

  // Returns the headers to include on every authenticated REST call.
  authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Gecko/1.0",
    };
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    if (this.sessionCookie) {
      headers.Cookie = this.sessionCookie;
    }
    return headers;
  }

  // Load persisted tokens (after a successful browser login round-trip).
  async load(): Promise<boolean> {
    try {
      if (!fs.existsSync(TOKEN_FILE)) return false;
      const raw = fs.readFileSync(TOKEN_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PersistedIbkrTokens>;
      if (typeof parsed.sessionToken !== "string" || typeof parsed.accessToken !== "string") {
        log.warn("IBKR token file malformed; ignoring");
        return false;
      }
      this.accessToken = parsed.accessToken;
      this.sessionCookie = `api=${parsed.sessionToken}`;
      log.info("Loaded persisted IBKR tokens");
      return true;
    } catch (err) {
      log.error("Failed to load IBKR tokens", { error: errStr(err) });
      return false;
    }
  }

  // Set tokens directly (used by the CLI auth helper after browser login).
  async setTokens(accessToken: string, sessionToken: string): Promise<void> {
    this.accessToken = accessToken;
    this.sessionCookie = `api=${sessionToken}`;
    await this.persist();
  }

  // Bootstrap: tickle once, verify auth status, then start the keepalive.
  async start(): Promise<void> {
    await this.tickle();
    const status = await this.authStatus();
    this.lastAuthOk = status.authenticated;
    if (!status.authenticated) {
      throw new Error(`IBKR session not authenticated. Run \`npm run auth:ibkr\` to log in.`);
    }
    log.info("IBKR auth bootstrap complete", { connected: status.connected });
    this.startKeepalive();
  }

  // Hit /tickle to keep the session alive. Captures the session token if
  // it rotates.
  async tickle(): Promise<IbkrTickleResponse | null> {
    try {
      const resp = await fetch(`${this.getBaseUrl()}/tickle`, {
        method: "POST",
        headers: this.authHeaders(),
      });
      if (!resp.ok) {
        log.warn("Tickle failed", { status: resp.status });
        return null;
      }
      const json = (await resp.json()) as IbkrTickleResponse;
      if (json.session && this.sessionCookie !== `api=${json.session}`) {
        this.sessionCookie = `api=${json.session}`;
        await this.persist();
      }
      this.lastTickleAt = Date.now();
      return json;
    } catch (err) {
      log.warn("Tickle error", { error: errStr(err) });
      return null;
    }
  }

  // Check /iserver/auth/status -- the canonical "am I logged in?" call.
  async authStatus(): Promise<IbkrAuthStatus> {
    try {
      const resp = await fetch(`${this.getBaseUrl()}/iserver/auth/status`, {
        method: "POST",
        headers: this.authHeaders(),
      });
      if (!resp.ok) {
        return { authenticated: false, competing: false, connected: false, message: `HTTP ${resp.status}` };
      }
      const json = (await resp.json()) as IbkrAuthStatus;
      return json;
    } catch (err) {
      return { authenticated: false, competing: false, connected: false, message: errStr(err) };
    }
  }

  // Re-issue session if it died. /iserver/reauthenticate kicks it back to life
  // if the underlying OAuth tokens are still valid.
  async reauthenticate(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.getBaseUrl()}/iserver/reauthenticate`, {
        method: "POST",
        headers: this.authHeaders(),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  isAuthenticated(): boolean {
    return this.lastAuthOk && Date.now() - this.lastTickleAt < 5 * 60 * 1000;
  }

  startKeepalive(): void {
    if (this.tickleTimer) return;
    this.tickleTimer = setInterval(() => {
      this.tickle().catch((err) => log.error("Tickle tick failed", { error: errStr(err) }));
    }, TICKLE_INTERVAL_MS);
    this.tickleTimer.unref?.();

    this.authCheckTimer = setInterval(() => {
      this.authStatus()
        .then(async (st) => {
          if (!st.authenticated && this.lastAuthOk) {
            log.warn("IBKR session dropped; attempting reauthenticate");
            const ok = await this.reauthenticate();
            log.info("Reauthenticate result", { ok });
          }
          this.lastAuthOk = st.authenticated;
        })
        .catch((err) => log.error("Auth status check failed", { error: errStr(err) }));
    }, AUTH_CHECK_INTERVAL_MS);
    this.authCheckTimer.unref?.();
  }

  stop(): void {
    if (this.tickleTimer) { clearInterval(this.tickleTimer); this.tickleTimer = null; }
    if (this.authCheckTimer) { clearInterval(this.authCheckTimer); this.authCheckTimer = null; }
  }

  private async persist(): Promise<void> {
    if (!this.accessToken || !this.sessionCookie) return;
    const sessionToken = this.sessionCookie.replace(/^api=/, "");
    const tokens: PersistedIbkrTokens = {
      accessToken: this.accessToken,
      sessionToken,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { /* best-effort */ }
  }
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
