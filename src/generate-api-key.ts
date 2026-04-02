import { config as dotenvConfig } from "dotenv";
import { ethers } from "ethers";
import { ClobClient } from "@polymarket/clob-client";

dotenvConfig();

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("ERROR: PRIVATE_KEY not set in .env");
    process.exit(1);
  }

  // Derive wallet address
  const wallet = new ethers.Wallet(privateKey);
  console.log(`Wallet address: ${wallet.address}`);
  console.log(`Set WALLET_ADDRESS=${wallet.address} in your .env\n`);

  // Create signer wrapper (ethers v6 -> v5 interface for SDK)
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

  const host = process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com";
  const chainId = Number(process.env.POLYMARKET_CHAIN_ID || "137");

  console.log(`Connecting to ${host} (chain ${chainId})...`);

  const client = new ClobClient(host, chainId, signer);

  // Try to derive existing key first, fall back to create
  console.log("\nAttempting to derive existing API key...");
  try {
    const derived = await client.deriveApiKey();
    console.log("\nAPI Key derived successfully!");
    console.log(`POLYMARKET_API_KEY=${derived.key}`);
    console.log(`POLYMARKET_SECRET=${derived.secret}`);
    console.log(`POLYMARKET_PASSPHRASE=${derived.passphrase}`);
    console.log("\nPaste these into your .env file.");
    return;
  } catch (err) {
    console.log(`Derive failed (${err instanceof Error ? err.message : String(err)}), creating new key...`);
  }

  try {
    const created = await client.createApiKey();
    console.log("\nAPI Key created successfully!");
    console.log(`POLYMARKET_API_KEY=${created.key}`);
    console.log(`POLYMARKET_SECRET=${created.secret}`);
    console.log(`POLYMARKET_PASSPHRASE=${created.passphrase}`);
    console.log("\nPaste these into your .env file.");
  } catch (err) {
    console.error(`\nFailed to create API key: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Make sure your wallet has been registered on Polymarket first.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
