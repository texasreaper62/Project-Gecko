// CLI: log into IBKR Client Portal and persist a session token.
//
// Usage:
//   npm run auth:ibkr
//
// What it does:
//   1. Confirms the local gateway is reachable at IBKR_BASE_URL.
//   2. Prints the URL operator should open to log in (typically
//      https://localhost:5000) and waits for the operator to confirm.
//   3. Pings /tickle and /iserver/auth/status to capture the session token.
//   4. Persists tokens to data/ibkr-tokens.json with 0600 permissions.
//
// Prereq: the operator MUST be running the IBKR Client Portal Gateway
// (clientportal.gw) on the same machine. Download from
// https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/ and
// follow the gateway install instructions.

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "../../core/config.js";
import { createLogger, setLogLevel } from "../../core/logger.js";
import { IbkrAuth } from "./auth.js";

const log = createLogger("ibkr-auth-cli");

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  // Allow self-signed local TLS for the gateway. Set per-invocation so we
  // don't pollute the rest of the bot's TLS posture.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const baseUrl = config.ibkrBaseUrl;
  const auth = new IbkrAuth({ baseUrl });

  const rl = readline.createInterface({ input: stdin, output: stdout });

  process.stdout.write("\n");
  process.stdout.write("===== IBKR Client Portal authorization =====\n\n");
  process.stdout.write("1. Make sure clientportal.gw is running locally.\n");
  process.stdout.write(`2. Open ${baseUrl.replace(/\/v1\/api\/?$/, "")} in a browser.\n`);
  process.stdout.write("3. Log in with your IBKR credentials and approve the session.\n");
  process.stdout.write("4. Return here and press Enter once you see 'Client login succeeds'.\n\n");

  await rl.question("Press Enter when logged in: ");
  rl.close();

  log.info("Tickling gateway to capture session token");
  const tickle = await auth.tickle();
  if (!tickle) {
    process.stderr.write("Tickle failed. Check that the gateway is running at the configured baseUrl.\n");
    process.exit(1);
  }

  const status = await auth.authStatus();
  if (!status.authenticated) {
    process.stderr.write(`Gateway reports not authenticated: ${JSON.stringify(status)}\n`);
    process.exit(1);
  }

  // The session cookie is now held inside auth via tickle; persist it.
  // We don't have a public OAuth bearer in the simple-gateway flow, so we
  // store an empty placeholder and rely on the session token alone.
  await auth.setTokens("local-gateway", tickle.session);
  log.info("IBKR session persisted to data/ibkr-tokens.json (mode 0600)");
  log.info("Sessions die after ~6 minutes idle; the bot keeps it alive via /tickle every 60s.");
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
