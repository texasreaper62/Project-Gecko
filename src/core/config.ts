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
  if (!val || val.trim() === "") return fallback;
  return val.trim();
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

export function loadConfig(): AppConfig {
  return {
    // Schwab API
    schwabClientId: required("SCHWAB_CLIENT_ID"),
    schwabClientSecret: required("SCHWAB_CLIENT_SECRET"),
    schwabRedirectUri: optional("SCHWAB_REDIRECT_URI", "https://localhost:8443/callback"),
    schwabAccountHash: required("SCHWAB_ACCOUNT_HASH"),

    // LLM
    anthropicApiKey: optional("ANTHROPIC_API_KEY", ""),
    llmEnabled: optionalBool("LLM_ENABLED", true),
    llmModel: optional("LLM_MODEL", "claude-sonnet-4-6"),

    // Mode
    liveTrading: optionalBool("LIVE_TRADING", false),
    killSwitch: optionalBool("KILL_SWITCH", false),

    // Risk
    maxRiskPerTradePct: boundedNumber("MAX_RISK_PER_TRADE_PCT", 1.0, 0.1, 5.0),
    maxConcurrentEquityPositions: boundedNumber("MAX_CONCURRENT_EQUITY_POSITIONS", 3, 1, 20),
    maxConcurrentOptionPositions: boundedNumber("MAX_CONCURRENT_OPTION_POSITIONS", 2, 1, 10),
    dailyLossLimitPct: boundedNumber("DAILY_LOSS_LIMIT_PCT", 3.0, 0.5, 20.0),
    maxDayTrades: boundedNumber("MAX_DAY_TRADES", 4, 1, 20),

    // Engine A (ORB)
    orbEnabled: optionalBool("ORB_ENABLED", true),
    orbMinGapPct: boundedNumber("ORB_MIN_GAP_PCT", 2.0, 0.5, 20.0),
    orbMinPremarketVolume: boundedNumber("ORB_MIN_PREMARKET_VOLUME", 500_000, 10_000, 100_000_000),
    orbMinPrice: boundedNumber("ORB_MIN_PRICE", 5.0, 1.0, 1000.0),
    orbMaxPrice: boundedNumber("ORB_MAX_PRICE", 50.0, 5.0, 10_000.0),

    // Engine B (0DTE SPY)
    dte0Enabled: optionalBool("DTE0_ENABLED", true),
    dte0MaxContractsPerTrade: boundedNumber("DTE0_MAX_CONTRACTS_PER_TRADE", 1, 1, 10),
    dte0MaxTradesPerDay: boundedNumber("DTE0_MAX_TRADES_PER_DAY", 2, 1, 10),

    // Notifications
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN", ""),
    telegramChatId: optional("TELEGRAM_CHAT_ID", ""),
    discordWebhookUrl: optional("DISCORD_WEBHOOK_URL", ""),

    // Logging
    logLevel: validateLogLevel(optional("LOG_LEVEL", "info")),
  };
}
