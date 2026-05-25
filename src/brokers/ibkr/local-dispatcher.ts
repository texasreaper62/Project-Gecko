// Scoped TLS bypass for the IBKR Client Portal Gateway.
//
// The local gateway (clientportal.gw) listens on https://localhost:5000 with
// a self-signed certificate that the Node TLS stack will reject by default.
// The naive fix is `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"`, but that
// is a PROCESS-GLOBAL setting: it would disable certificate validation for
// every subsequent outbound HTTPS call (Anthropic API, Telegram, Discord,
// Yahoo, etc.), leaking the gateway-trust into the public internet.
//
// Instead we instantiate a single undici Dispatcher that disables cert
// verification only for connections it makes, and pass it via the per-call
// `dispatcher` option on fetch(). Calls that don't pass it use the normal
// global TLS-validating defaults.
//
// Use: `fetch(url, { ..., dispatcher: localGatewayDispatcher })` for every
// outbound call to https://localhost:5000/v1/api/*.

import { Agent } from "undici";

export const localGatewayDispatcher = new Agent({
  connect: { rejectUnauthorized: false },
});
