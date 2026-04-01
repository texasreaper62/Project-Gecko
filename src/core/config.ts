import { config as dotenvConfig } from "dotenv";
import type { AppConfig, LogLevel } from "./types.js";

dotenvConfig();

function required(name: string): string {
  const val = process.env[name];
  if (!val || val.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val.trim();
}

function optional(name: string, fallback: string): string {
  const val = process.env[name];
  if (!val || val.trim() === "") {
    return fallback;
  }
  return val.trim();
}

function requiredNumber(name: string): number {
  const raw = required(name);
  const num = Number(raw);
  if (Number.isNaN(num)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${raw}`);
  }
  return num;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const num = Number(raw.trim());
  if (Number.isNaN(num)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${raw}`);
  }
  return num;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  return raw.trim().toLowerCase() === "true";
}

function boundedNumber(name: string, fallback: number, min: number, max: number): number {
  const val = optionalNumber(name, fallback);
  if (val < min || val > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got: ${val}`);
  }
  return val;
}

function validateLogLevel(val: string): LogLevel {
  const valid: LogLevel[] = ["debug", "info", "warn", "error"];
  if (!valid.includes(val as LogLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${valid.join(", ")}, got: ${val}`);
  }
  return val as LogLevel;
}

function validateHex(name: string, value: string): string {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${name} must be a hex string starting with 0x (got: ${value.slice(0, 6)}...)`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const privateKey = required("PRIVATE_KEY");
  validateHex("PRIVATE_KEY", privateKey);

  const walletAddress = required("WALLET_ADDRESS");
  validateHex("WALLET_ADDRESS", walletAddress);

  return {
    // Wallet
    privateKey,
    walletAddress,
    funderAddress: optional("FUNDER_ADDRESS", ""),
    signatureType: optionalNumber("SIGNATURE_TYPE", 0),

    // Polymarket
    polymarketApiKey: required("POLYMARKET_API_KEY"),
    polymarketSecret: required("POLYMARKET_SECRET"),
    polymarketPassphrase: required("POLYMARKET_PASSPHRASE"),
    polymarketClobUrl: optional("POLYMARKET_CLOB_URL", "https://clob.polymarket.com"),
    polymarketChainId: optionalNumber("POLYMARKET_CHAIN_ID", 137),

    // Polygon RPC
    polygonRpcUrl: required("POLYGON_RPC_URL"),
    polygonWsUrl: optional("POLYGON_WS_URL", ""),

    // Feeds
    binanceWsUrl: optional("BINANCE_WS_URL", "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade"),
    coinbaseWsUrl: optional("COINBASE_WS_URL", "wss://ws-feed.exchange.coinbase.com"),

    // Kalshi (optional for now)
    kalshiApiKey: optional("KALSHI_API_KEY", ""),
    kalshiPrivateKeyPath: optional("KALSHI_PRIVATE_KEY_PATH", ""),
    kalshiApiUrl: optional("KALSHI_API_URL", "https://api.elections.kalshi.com/trade-api/v2"),

    // Trading (with bounds validation)
    minSpreadThreshold: boundedNumber("MIN_SPREAD_THRESHOLD", 5.0, 0.1, 50),
    maxPositionSize: boundedNumber("MAX_POSITION_SIZE", 50, 1, 10_000),
    maxTotalExposure: boundedNumber("MAX_TOTAL_EXPOSURE", 1000, 10, 100_000),
    maxOpenPositions: boundedNumber("MAX_OPEN_POSITIONS", 5, 1, 50),
    minLiquidity: boundedNumber("MIN_LIQUIDITY", 500, 0, 100_000),
    killSwitch: optionalBool("KILL_SWITCH", false),
    liveTrading: optionalBool("LIVE_TRADING", false),

    // Monitoring
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN", ""),
    telegramChatId: optional("TELEGRAM_CHAT_ID", ""),
    discordWebhookUrl: optional("DISCORD_WEBHOOK_URL", ""),

    // Logging
    logLevel: validateLogLevel(optional("LOG_LEVEL", "info")),
  };
}
