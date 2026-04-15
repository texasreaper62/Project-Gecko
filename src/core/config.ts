/**
 * CONFIG: Environment variable loading and validation for Gecko v2
 */

import { createLogger } from './logger.js';
import type { GeckoConfig, LogLevel } from './types.js';

const log = createLogger('config');

function requireEnv(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined || val === '') {
    log.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export function loadConfig(): GeckoConfig {
  // Load .env if available (sync require, not async import)
  try {
    require('dotenv').config();
  } catch {
    // dotenv not installed, env vars must be set externally
  }

  const config: GeckoConfig = {
    startingCapital: Number(optionalEnv('STARTING_CAPITAL', '5000')),
    brokerId: optionalEnv('BROKER_ID', 'paper') as 'ibkr' | 'alpaca' | 'paper',
    claudeApiKey: optionalEnv('CLAUDE_API_KEY', ''),
    telegramBotToken: optionalEnv('TELEGRAM_BOT_TOKEN', ''),
    telegramChatId: optionalEnv('TELEGRAM_CHAT_ID', ''),
    liveTrading: optionalEnv('LIVE_TRADING', 'false') === 'true',
    maxPositionPercent: Number(optionalEnv('MAX_POSITION_PERCENT', '0.12')),
    maxDeployedPercent: Number(optionalEnv('MAX_DEPLOYED_PERCENT', '0.60')),
    dailyLossLimitPercent: Number(optionalEnv('DAILY_LOSS_LIMIT_PERCENT', '0.03')),
    enableNetNet: optionalEnv('ENABLE_NET_NET', 'true') === 'true',
    enableSpinoff: optionalEnv('ENABLE_SPINOFF', 'true') === 'true',
    enablePead: optionalEnv('ENABLE_PEAD', 'false') === 'true',
    enableRegSho: optionalEnv('ENABLE_REG_SHO', 'true') === 'true',
    logLevel: optionalEnv('LOG_LEVEL', 'info') as LogLevel,
  };

  log.info('Config loaded', {
    capital: config.startingCapital,
    broker: config.brokerId,
    live: config.liveTrading,
    strategies: {
      netNet: config.enableNetNet,
      spinoff: config.enableSpinoff,
      pead: config.enablePead,
      regSho: config.enableRegSho,
    },
  });

  return config;
}
