// CLI: drive the Schwab OAuth authorization flow.
//
// Usage:
//   npm run auth
//
// What it does:
//   1. Prints the Schwab /v1/oauth/authorize URL.
//   2. Operator opens it in a browser, logs in to Schwab, approves the app.
//   3. Browser redirects to the registered https redirect_uri with ?code=...
//      (the page itself will fail to load -- expected, since we run no server).
//   4. Operator copies the FULL URL from the browser address bar and pastes it
//      back into the terminal.
//   5. We extract the `code` parameter, exchange it for tokens, and persist.
//
// Why no local HTTPS server: Schwab requires https on the redirect_uri.
// Spinning up a TLS server with a trusted cert for one-shot use is more
// friction than copy-paste, and the operator only has to do this once a week.

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "../../core/config.js";
import { createLogger, setLogLevel } from "../../core/logger.js";
import { SchwabAuth } from "./auth.js";

const log = createLogger("auth-cli");

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const auth = new SchwabAuth({
    clientId: config.schwabClientId,
    clientSecret: config.schwabClientSecret,
    redirectUri: config.schwabRedirectUri,
  });

  const rl = readline.createInterface({ input: stdin, output: stdout });

  process.stdout.write("\n");
  process.stdout.write("===== Schwab OAuth authorization =====\n\n");
  process.stdout.write("1. Open the following URL in a browser logged into Schwab:\n\n");
  process.stdout.write(`   ${auth.getAuthorizeUrl()}\n\n`);
  process.stdout.write("2. Approve the app. Schwab will redirect to your registered https URL.\n");
  process.stdout.write("   That page will fail to load -- that is expected.\n\n");
  process.stdout.write("3. Copy the full URL from the browser address bar and paste it below.\n\n");

  const pasted = (await rl.question("Pasted callback URL: ")).trim();
  rl.close();

  let code: string | null = null;
  try {
    const u = new URL(pasted);
    code = u.searchParams.get("code");
  } catch {
    // Operator may have pasted just the ?code=... portion or the code itself.
    const match = pasted.match(/[?&]code=([^&]+)/);
    code = match ? decodeURIComponent(match[1]) : pasted;
  }

  if (!code || code.length < 10) {
    process.stderr.write("Could not extract authorization code from input. Aborting.\n");
    process.exit(1);
  }

  log.info("Exchanging authorization code for tokens");
  await auth.exchangeCode(code);
  log.info("OAuth complete. Tokens persisted to data/oauth-tokens.json (mode 0600).");
  log.info("This refresh token expires in 7 days. Re-run `npm run auth` before then.");
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
