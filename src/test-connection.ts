import { config as dotenvConfig } from "dotenv";
import { ethers } from "ethers";
import { ClobClient } from "@polymarket/clob-client";

dotenvConfig();

function check(label: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    console.error(`MISSING: ${label} not set in .env`);
    return "";
  }
  return value.trim();
}

async function main(): Promise<void> {
  console.log("=== Project Gecko Connection Test ===\n");

  // 1. Test unauthenticated CLOB connection
  const clobUrl = check("POLYMARKET_CLOB_URL", process.env.POLYMARKET_CLOB_URL) || "https://clob.polymarket.com";
  console.log(`[1/5] Testing CLOB connection (${clobUrl})...`);
  try {
    const resp = await fetch(`${clobUrl}/time`);
    const data = await resp.json();
    console.log(`  OK: Server time = ${JSON.stringify(data)}\n`);
  } catch (err) {
    console.error(`  FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // 2. Test authenticated CLOB connection
  const apiKey = check("POLYMARKET_API_KEY", process.env.POLYMARKET_API_KEY);
  const secret = check("POLYMARKET_SECRET", process.env.POLYMARKET_SECRET);
  const passphrase = check("POLYMARKET_PASSPHRASE", process.env.POLYMARKET_PASSPHRASE);
  const privateKey = check("PRIVATE_KEY", process.env.PRIVATE_KEY);

  if (apiKey && secret && passphrase && privateKey) {
    console.log("[2/5] Testing authenticated CLOB connection...");
    try {
      const wallet = new ethers.Wallet(privateKey);
      const signer = {
        _signTypedData: (
          domain: Record<string, unknown>,
          types: Record<string, Array<{ name: string; type: string }>>,
          value: Record<string, unknown>,
        ) =>
          wallet.signTypedData(
            domain as ethers.TypedDataDomain,
            types as Record<string, ethers.TypedDataField[]>,
            value,
          ),
        getAddress: () => Promise.resolve(wallet.address),
      };

      const chainId = Number(process.env.POLYMARKET_CHAIN_ID || "137");
      const client = new ClobClient(
        clobUrl,
        chainId,
        signer,
        { key: apiKey, secret, passphrase },
        Number(process.env.SIGNATURE_TYPE || "0"),
        process.env.FUNDER_ADDRESS || undefined,
      );

      const apiKeys = await client.getApiKeys();
      console.log(`  OK: Found ${(apiKeys as any).apiKeys?.length ?? 0} API key(s)\n`);
    } catch (err) {
      console.error(`  FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else {
    console.log("[2/5] SKIP: Missing API credentials\n");
  }

  // 3. Fetch one market
  console.log("[3/5] Fetching a sample market from Gamma API...");
  try {
    const resp = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=1");
    const markets = await resp.json() as { question: string; condition_id: string; tokens: { price: number }[] }[];
    if (markets.length > 0) {
      const m = markets[0];
      console.log(`  OK: "${m.question}"`);
      console.log(`  Condition ID: ${m.condition_id}`);
      if (m.tokens?.length > 0) {
        console.log(`  YES price: ${m.tokens[0].price}`);
      }
    }
    console.log();
  } catch (err) {
    console.error(`  FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // 4. Test Alchemy RPC
  const rpcUrl = check("POLYGON_RPC_URL", process.env.POLYGON_RPC_URL);
  if (rpcUrl) {
    console.log("[4/5] Testing Polygon RPC...");
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const blockNumber = await provider.getBlockNumber();
      console.log(`  OK: Current block = ${blockNumber}\n`);
      provider.destroy();
    } catch (err) {
      console.error(`  FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else {
    console.log("[4/5] SKIP: POLYGON_RPC_URL not set\n");
  }

  // 5. Test wallet balance
  if (rpcUrl && privateKey) {
    console.log("[5/5] Checking USDC.e balance...");
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(privateKey);
      const usdcContract = new ethers.Contract(
        "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        ["function balanceOf(address) view returns (uint256)"],
        provider,
      );
      const balance: bigint = await usdcContract.balanceOf(wallet.address);
      const usdc = Number(balance) / 1_000_000;
      console.log(`  Wallet: ${wallet.address}`);
      console.log(`  USDC.e balance: $${usdc.toFixed(2)}`);
      if (usdc < 10) {
        console.log(`  WARNING: Balance too low for live trading (need at least $10)`);
      }
      provider.destroy();
    } catch (err) {
      console.error(`  FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else {
    console.log("[5/5] SKIP: Missing RPC or private key\n");
  }

  console.log("\n=== Test complete ===");
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
