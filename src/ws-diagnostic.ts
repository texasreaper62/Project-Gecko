import WebSocket from "ws";
import { config as dotenvConfig } from "dotenv";
import { fetchWithRetry } from "./utils/retry.js";

dotenvConfig();

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CLOB_URL = process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com";

async function getActiveTokenIds(): Promise<{ tokenId: string; conditionId: string; slug: string }[]> {
  const now = Math.floor(Date.now() / 1000);
  const windowOpen = Math.floor(now / 300) * 300;
  const slug = `btc-updown-5m-${windowOpen}`;

  console.log(`\nFetching market for slug: ${slug}`);

  // Get conditionId from Gamma
  const gammaResp = await fetch(`${GAMMA_BASE}/events?slug=${slug}`);
  const gammaText = await gammaResp.text();
  const gammaEvents = JSON.parse(gammaText.replace(/([:,\[]\s*)(-?\d{16,})(\s*[,\]\}])/g, '$1"$2"$3'));
  const market = gammaEvents[0]?.markets?.[0];

  if (!market) {
    console.log("No market found for slug");
    return [];
  }

  const conditionId = market.conditionId || market.condition_id;
  console.log(`Condition ID: ${conditionId}`);

  // Get token IDs from CLOB
  const clobResp = await fetch(`${CLOB_URL}/markets/${conditionId}`);
  const clobText = await clobResp.text();
  const clobData = JSON.parse(clobText);

  if (!clobData.tokens || clobData.tokens.length === 0) {
    console.log("No tokens from CLOB API");
    console.log("CLOB response keys:", Object.keys(clobData).join(", "));
    console.log("CLOB response (first 500):", clobText.slice(0, 500));
    return [];
  }

  const results = clobData.tokens.map((t: { token_id: string; outcome: string }) => ({
    tokenId: String(t.token_id),
    conditionId,
    slug,
  }));

  console.log(`Got ${results.length} tokens:`);
  for (const r of results) {
    console.log(`  Token ID (${r.tokenId.length} chars): ${r.tokenId}`);
  }

  return results;
}

async function testSubscription(
  label: string,
  message: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve) => {
    console.log(`\n--- Test: ${label} ---`);
    console.log(`Sending: ${JSON.stringify(message)}`);

    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => {
      console.log(`  Result: TIMEOUT (no response in 5s)`);
      ws.close();
      resolve();
    }, 5000);

    let messageCount = 0;

    ws.on("open", () => {
      console.log(`  Connected`);
      ws.send(JSON.stringify(message));
    });

    ws.on("message", (data: Buffer) => {
      messageCount++;
      const str = data.toString();
      if (str === "PONG") return;

      if (messageCount <= 3) {
        console.log(`  MSG ${messageCount}: ${str.slice(0, 200)}`);
      }

      // If we get valid JSON data, the subscription worked
      if (str.startsWith("{") || str.startsWith("[")) {
        console.log(`  SUCCESS: Got valid JSON data!`);
        clearTimeout(timeout);
        setTimeout(() => { ws.close(); resolve(); }, 1000);
      } else if (str === "INVALID OPERATION") {
        console.log(`  FAILED: Server rejected with INVALID OPERATION`);
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    });

    ws.on("error", (err: Error) => {
      console.log(`  ERROR: ${err.message}`);
      clearTimeout(timeout);
      resolve();
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  console.log("=== Polymarket WebSocket Diagnostic ===\n");

  const tokens = await getActiveTokenIds();
  if (tokens.length === 0) {
    console.log("Cannot proceed without token IDs");
    process.exit(1);
  }

  const tokenId = tokens[0].tokenId;
  const conditionId = tokens[0].conditionId;

  // Test 1: Current format (what we're sending)
  await testSubscription("Current format (assets_ids with token ID)", {
    type: "market",
    markets: [],
    assets_ids: [tokenId],
    initial_dump: true,
  });

  // Test 2: Condition ID in markets field instead
  await testSubscription("Condition ID in markets field", {
    type: "market",
    markets: [conditionId],
    assets_ids: [],
    initial_dump: true,
  });

  // Test 3: Both fields populated
  await testSubscription("Both markets and assets_ids", {
    type: "market",
    markets: [conditionId],
    assets_ids: [tokenId],
    initial_dump: true,
  });

  // Test 4: Without initial_dump
  await testSubscription("Without initial_dump", {
    type: "market",
    markets: [],
    assets_ids: [tokenId],
  });

  // Test 5: With a known working long-lived market token
  // Try fetching a popular non-crypto market to see if ANY subscription works
  console.log("\nFetching a popular long-lived market...");
  try {
    const resp = await fetch(`${GAMMA_BASE}/markets?active=true&closed=false&limit=1&order=volume&ascending=false`);
    const markets = await resp.json() as { conditionId?: string; condition_id?: string }[];
    if (markets[0]) {
      const popCondId = markets[0].conditionId || markets[0].condition_id;
      if (popCondId) {
        const clobResp = await fetch(`${CLOB_URL}/markets/${popCondId}`);
        const clobData = await clobResp.json() as { tokens?: { token_id: string }[] };
        if (clobData.tokens && clobData.tokens[0]) {
          const popTokenId = String(clobData.tokens[0].token_id);
          console.log(`Popular market token ID (${popTokenId.length} chars): ${popTokenId.slice(0, 40)}...`);

          await testSubscription("Popular market token ID", {
            type: "market",
            markets: [],
            assets_ids: [popTokenId],
            initial_dump: true,
          });
        }
      }
    }
  } catch (err) {
    console.log("Failed to test popular market:", err);
  }

  console.log("\n=== Diagnostic complete ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
