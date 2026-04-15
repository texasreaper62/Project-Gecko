/**
 * Project Gecko v2 -- Multi-Strategy Trading Agent
 *
 * Architecture: Constrained Autonomy (D0-inspired)
 *
 * SCOUT --finds--> ANALYST --proposes--> SENTINEL --adjudicates--> EXECUTOR
 *                                                                     |
 *                          RECORDER <--records-- all steps -----------+
 *                              |
 *                          feedback loop (outcomes -> context -> better decisions)
 *
 * The model reasons freely. The system executes within hard boundaries.
 */

import { createLogger, setLogLevel } from './core/logger.js';
import { scanEdgar, loadCikTickerMap } from './agents/scout/edgar-monitor.js';
import { scanThresholdList } from './agents/scout/reg-sho-monitor.js';
import { analyzeOpportunity } from './agents/analyst/analyst.js';
import { adjudicate } from './agents/sentinel/constraint-engine.js';
import { setPeakEquity } from './agents/sentinel/constraint-engine.js';
import {
  recordOpportunity,
  recordAction,
  recordVerdict,
  generateDailySummary,
} from './agents/recorder/trade-recorder.js';
import type { AccountState, Opportunity, GeckoConfig } from './core/types.js';
import { createFact } from './core/types.js';

const log = createLogger('gecko');

// ============================================================
// CONFIGURATION
// ============================================================

function loadConfig(): GeckoConfig {
  return {
    startingCapital: Number(process.env.STARTING_CAPITAL ?? '5000'),
    brokerId: (process.env.BROKER_ID ?? 'paper') as 'ibkr' | 'alpaca' | 'paper',
    claudeApiKey: process.env.CLAUDE_API_KEY ?? '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
    liveTrading: process.env.LIVE_TRADING === 'true',
    maxPositionPercent: Number(process.env.MAX_POSITION_PERCENT ?? '0.12'),
    maxDeployedPercent: Number(process.env.MAX_DEPLOYED_PERCENT ?? '0.60'),
    dailyLossLimitPercent: Number(process.env.DAILY_LOSS_LIMIT_PERCENT ?? '0.03'),
    enableNetNet: process.env.ENABLE_NET_NET !== 'false',
    enableSpinoff: process.env.ENABLE_SPINOFF !== 'false',
    enablePead: process.env.ENABLE_PEAD === 'true',
    enableRegSho: process.env.ENABLE_REG_SHO !== 'false',
    logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  };
}

// ============================================================
// MOCK ACCOUNT STATE (replaced by IBKR API in production)
// ============================================================

function getPaperAccountState(config: GeckoConfig): AccountState {
  return {
    equity: createFact(config.startingCapital, 'paper', 'verified', 60_000),
    buyingPower: createFact(config.startingCapital * 2, 'paper', 'verified', 60_000),
    openPositions: createFact([], 'paper', 'verified', 60_000),
    dailyPnl: createFact(0, 'paper', 'verified', 60_000),
    pendingOrders: createFact([], 'paper', 'verified', 60_000),
  };
}

// ============================================================
// MAIN AGENT LOOP
// ============================================================

async function runScoutCycle(account: AccountState): Promise<void> {
  log.info('Scout cycle starting');

  // 1. SCOUT: Find opportunities
  const opportunities: Opportunity[] = [];

  try {
    const edgarOpps = await scanEdgar();
    opportunities.push(...edgarOpps);
  } catch (err) {
    log.error('EDGAR scan failed', { error: err instanceof Error ? err.message : String(err) });
  }

  try {
    const regShoOpps = await scanThresholdList();
    opportunities.push(...regShoOpps);
  } catch (err) {
    log.error('Reg SHO scan failed', { error: err instanceof Error ? err.message : String(err) });
  }

  if (opportunities.length === 0) {
    log.debug('No opportunities found this cycle');
    return;
  }

  log.info(`Found ${opportunities.length} opportunities`);

  // 2. For each opportunity: ANALYST -> SENTINEL -> EXECUTOR
  for (const opp of opportunities) {
    recordOpportunity(opp);

    // ANALYST: Generate typed action
    const action = analyzeOpportunity(opp, account);
    if (!action) {
      log.debug('Analyst passed on opportunity', { id: opp.id, type: opp.type });
      continue;
    }
    recordAction(action);

    // SENTINEL: Adjudicate
    const verdict = adjudicate(action, account);
    recordVerdict(verdict);

    switch (verdict.type) {
      case 'PASS':
        log.info('Action APPROVED', {
          ticker: action.ticker,
          strategy: action.strategy,
          size: action.positionSizeDollars,
          conviction: action.conviction,
        });

        // EXECUTOR: In paper mode, just log. In live, would submit to IBKR.
        log.info('PAPER TRADE: Would execute', {
          ticker: action.ticker,
          side: action.side,
          quantity: action.quantity,
          limitPrice: action.limitPrice,
          stopLoss: action.stopLoss,
          takeProfit: action.takeProfit,
        });
        break;

      case 'HOLD':
        log.info('Action HELD for review', {
          ticker: action.ticker,
          reasons: verdict.reasons,
        });
        break;

      case 'REJECT':
        log.info('Action REJECTED', {
          ticker: action.ticker,
          reasons: verdict.reasons,
          failed: verdict.constraintsFailed,
        });
        break;

      case 'ESCALATE':
        log.warn('Action ESCALATED to human', {
          ticker: action.ticker,
          reasons: verdict.reasons,
        });
        // TODO: Send Telegram alert for human review
        break;

      case 'SUSPEND':
        log.warn('Action SUSPENDED (stale state)', {
          ticker: action.ticker,
          reasons: verdict.reasons,
        });
        break;
    }
  }
}

// ============================================================
// STARTUP
// ============================================================

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  log.info('Project Gecko v2 starting', {
    mode: config.liveTrading ? 'LIVE' : 'PAPER',
    broker: config.brokerId,
    capital: config.startingCapital,
    strategies: {
      netNet: config.enableNetNet,
      spinoff: config.enableSpinoff,
      pead: config.enablePead,
      regSho: config.enableRegSho,
    },
  });

  // Load CIK-ticker mapping
  await loadCikTickerMap();

  // Initialize account state
  const account = getPaperAccountState(config);
  setPeakEquity(config.startingCapital);

  log.info('System initialized. Starting agent loop.');

  // Run scout cycle every 60 seconds
  const SCOUT_INTERVAL_MS = 60_000;

  const runLoop = async (): Promise<void> => {
    try {
      await runScoutCycle(account);
    } catch (err) {
      log.error('Scout cycle error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Initial run
  await runLoop();

  // Recurring loop
  setInterval(runLoop, SCOUT_INTERVAL_MS);

  // Daily summary at midnight UTC
  const scheduleDaily = (): void => {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    const msUntilMidnight = midnight.getTime() - now.getTime();

    setTimeout(() => {
      const summary = generateDailySummary();
      log.info('Daily summary', { summary });
      scheduleDaily(); // Reschedule
    }, msUntilMidnight);
  };
  scheduleDaily();

  // Keep alive
  log.info('Agent loop running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  log.error('Fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
