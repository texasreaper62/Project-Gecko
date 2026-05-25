// Broker factory: selects Schwab or IBKR based on AppConfig.broker.
//
// Loads broker-specific auth tokens, instantiates REST + stream clients,
// and returns a Broker satisfying the unified interface. Throws a clear
// error if tokens are missing so the operator knows which auth CLI to run.

import { createLogger } from "../core/logger.js";
import type { AppConfig } from "../core/types.js";
import type { Broker } from "./broker.js";

import { SchwabAuth } from "./schwab/auth.js";
import { SchwabRest } from "./schwab/rest.js";
import { SchwabStream } from "./schwab/stream.js";
import { SchwabBroker } from "./schwab/broker.js";

import { IbkrAuth } from "./ibkr/auth.js";
import { IbkrRest } from "./ibkr/rest.js";
import { IbkrStream } from "./ibkr/stream.js";
import { IbkrBroker } from "./ibkr/broker.js";

const log = createLogger("broker-factory");

export async function createBroker(config: AppConfig): Promise<Broker> {
  if (config.broker === "ibkr") {
    log.info("Initializing IBKR broker", { baseUrl: config.ibkrBaseUrl });
    // Self-signed cert handling for the local gateway is scoped per-call
    // via brokers/ibkr/local-dispatcher.ts and the WsManager
    // rejectUnauthorized option. We do NOT mutate the process-global
    // NODE_TLS_REJECT_UNAUTHORIZED — doing so would silently disable cert
    // validation for every other outbound HTTPS in the process (Anthropic,
    // Telegram, Discord, Yahoo, etc.) and leak high-value credentials to
    // any on-path attacker presenting a forged cert.
    const auth = new IbkrAuth({ baseUrl: config.ibkrBaseUrl });
    const loaded = await auth.load();
    if (!loaded) {
      throw new Error("No IBKR tokens. Start the clientportal.gw gateway and run `npm run auth:ibkr`.");
    }
    const rest = new IbkrRest(auth);
    const stream = new IbkrStream(auth, config.ibkrBaseUrl);
    return new IbkrBroker(auth, rest, stream);
  }

  // Default: Schwab
  log.info("Initializing Schwab broker");
  const auth = new SchwabAuth({
    clientId: config.schwabClientId,
    clientSecret: config.schwabClientSecret,
    redirectUri: config.schwabRedirectUri,
  });
  const loaded = await auth.load();
  if (!loaded) {
    throw new Error("No Schwab tokens. Run `npm run auth` to authorize.");
  }
  auth.startAutoRefresh();
  const rest = new SchwabRest(auth);
  const stream = new SchwabStream(auth, rest);
  return new SchwabBroker(auth, rest, stream, config.schwabAccountHash);
}
