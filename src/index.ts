/**
 * Project Gecko v2 -- Multi-Strategy Trading Agent
 *
 * Architecture: Constrained Autonomy
 *
 * SCOUT --finds--> ANALYST --proposes--> SENTINEL --adjudicates--> EXECUTOR
 *                                                                     |
 *                          RECORDER <--records-- all steps -----------+
 *
 * Strategies:
 * - Net-Net Deep Value (92% profit probability, Sharpe 1.51)
 * - Spin-Off Special Situations (72% profit probability)
 * - Reg SHO Forced Covering (structural edge)
 * - PEAD Debit Spreads (options amplification on earnings drift)
 * - Insider Cluster Detection (Form 4 cluster buying)
 */

import { createLogger, setLogLevel } from './core/logger.js';
import type { AccountState, Opportunity, GeckoConfig, LogLevel } from './core/types.js';
import { createFact } from './core/types.js';

// Agents
import { scanEdgar, loadCikTickerMap } from './agents/scout/edgar-monitor.js';
import { scanThresholdList } from './agents/scout/reg-sho-monitor.js';
import { scanForPead } from './agents/scout/pead-scanner.js';
import { loadScreenUniverse, screenBatch, getUniverseSize } from './agents/scout/net-net-screener.js';
import { analyzeOpportunity } from './agents/analyst/analyst.js';
import { adjudicate, setPeakEquity } from './agents/sentinel/constraint-engine.js';
import {
  initPaperAccount,
  getPaperAccountState,
  executeAction,
  checkPositionExits,
  resetDailyPnl,
  getEquity,
  getPositionCount,
} from './agents/executor/paper-executor.js';
import {
  recordOpportunity,
  recordAction,
  recordVerdict,
  generateDailySummary,
  getTradeHistory,
} from './agents/recorder/trade-recorder.js';
import { TelegramNotifier } from './monitoring/telegram.js';

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
    logLevel: (process.env.LOG_LEVEL ?? 'info') as LogLevel,
  };
}

// ============================================================
// AGENT PIPELINE
// ============================================================

async function processOpportunity(
  opp: Opportunity,
  account: AccountState,
  telegram: TelegramNotifier,
  config: GeckoConfig
): Promise<void> {
  recordOpportunity(opp);

  // ANALYST: Generate typed action
  const action = analyzeOpportunity(opp, account);
  if (!action) {
    log.debug('Analyst passed on opportunity', { id: opp.id, type: opp.type });
    return;
  }
  recordAction(action);

  // SENTINEL: Adjudicate (constraint engine is invisible to Analyst)
  const verdict = adjudicate(action, account);
  recordVerdict(verdict);

  switch (verdict.type) {
    case 'PASS':
      log.info('APPROVED', {
        ticker: action.ticker,
        strategy: action.strategy,
        size: action.positionSizeDollars,
        conviction: action.conviction,
      });

      if (config.brokerId === 'paper') {
        // Paper trading: simulate execution
        const result = executeAction(action);
        await telegram.send(
          `<b>PAPER TRADE</b>\n` +
          `${action.side} ${action.ticker} (${action.strategy})\n` +
          `Qty: ${action.quantity} @ $${result.filledPrice}\n` +
          `Size: $${action.positionSizeDollars} | Conv: ${action.conviction}/100\n` +
          `Stop: $${action.stopLoss} | Target: $${action.takeProfit}\n` +
          `Reason: ${action.rationale.slice(0, 100)}`
        );
      } else {
        // Live trading: would submit to IBKR
        log.warn('Live execution not yet implemented. Action approved but not executed.', {
          ticker: action.ticker,
        });
      }
      break;

    case 'HOLD':
      log.info('HELD', { ticker: action.ticker, reasons: verdict.reasons });
      break;

    case 'REJECT':
      log.info('REJECTED', {
        ticker: action.ticker,
        reasons: verdict.reasons,
        failed: verdict.constraintsFailed,
      });
      break;

    case 'ESCALATE':
      log.warn('ESCALATED', { ticker: action.ticker, reasons: verdict.reasons });
      await telegram.send(
        `<b>ESCALATED - Human Review Needed</b>\n` +
        `${action.ticker} (${action.strategy})\n` +
        `Reasons: ${verdict.reasons.join(', ')}`
      );
      break;

    case 'SUSPEND':
      log.warn('SUSPENDED', { ticker: action.ticker, reasons: verdict.reasons });
      break;
  }
}

// ============================================================
// MAIN SCAN CYCLES
// ============================================================

/** Fast cycle: EDGAR + Reg SHO (every 60 seconds) */
async function fastCycle(
  account: AccountState,
  telegram: TelegramNotifier,
  config: GeckoConfig
): Promise<void> {
  log.debug('Fast scan cycle');
  const opportunities: Opportunity[] = [];

  // EDGAR filings
  try {
    const edgarOpps = await scanEdgar();
    opportunities.push(...edgarOpps);
  } catch (err) {
    log.error('EDGAR scan error', { error: err instanceof Error ? err.message : String(err) });
  }

  // Reg SHO threshold list
  if (config.enableRegSho) {
    try {
      const regShoOpps = await scanThresholdList();
      opportunities.push(...regShoOpps);
    } catch (err) {
      log.error('Reg SHO scan error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // PEAD scanner
  if (config.enablePead) {
    try {
      const peadOpps = await scanForPead();
      opportunities.push(...peadOpps);
    } catch (err) {
      log.error('PEAD scan error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Process all found opportunities
  for (const opp of opportunities) {
    await processOpportunity(opp, account, telegram, config);
  }

  // Check paper position exits
  if (config.brokerId === 'paper') {
    const closedTrades = checkPositionExits();
    for (const trade of closedTrades) {
      await telegram.send(
        `<b>PAPER CLOSE</b>\n` +
        `${trade.ticker} (${trade.strategy})\n` +
        `P&L: $${trade.pnlDollars.toFixed(2)} (${trade.pnlPercent}%)\n` +
        `Exit: ${trade.exitReason} after ${trade.holdDays.toFixed(0)} days`
      );
    }
  }
}

/** Slow cycle: Net-Net screening (weekly, processes in batches) */
let netNetBatchIndex = 0;

async function slowCycle(
  account: AccountState,
  telegram: TelegramNotifier,
  config: GeckoConfig
): Promise<void> {
  if (!config.enableNetNet) return;

  log.info('Net-net screening batch', { startIndex: netNetBatchIndex });

  try {
    const netNetOpps = await screenBatch(netNetBatchIndex, 50);
    netNetBatchIndex += 50;

    // Reset when we've screened the full universe
    if (netNetBatchIndex >= getUniverseSize()) {
      netNetBatchIndex = 0;
      log.info('Net-net full universe scan complete, restarting');
    }

    for (const opp of netNetOpps) {
      await processOpportunity(opp, account, telegram, config);
    }
  } catch (err) {
    log.error('Net-net scan error', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ============================================================
// DAILY REPORT
// ============================================================

async function sendDailyReport(telegram: TelegramNotifier): Promise<void> {
  const summary = generateDailySummary();
  const equity = getEquity();
  const positions = getPositionCount();
  const recentTrades = getTradeHistory(5);

  let message = `<b>GECKO DAILY REPORT</b>\n`;
  message += `Date: ${summary.date}\n`;
  message += `Equity: $${equity.toFixed(2)}\n`;
  message += `Open Positions: ${positions}\n`;
  message += `Today: ${summary.totalTrades} trades | P&L: $${summary.pnl.toFixed(2)}\n`;
  message += `Wins: ${summary.wins} | Losses: ${summary.losses}\n\n`;

  if (Object.keys(summary.strategySummary).length > 0) {
    message += `<b>By Strategy:</b>\n`;
    for (const [strat, data] of Object.entries(summary.strategySummary)) {
      message += `  ${strat}: ${data.trades} trades, $${data.pnl.toFixed(2)}\n`;
    }
  }

  if (Object.keys(summary.verdictSummary).length > 0) {
    message += `\n<b>Verdicts:</b>\n`;
    for (const [type, count] of Object.entries(summary.verdictSummary)) {
      message += `  ${type}: ${count}\n`;
    }
  }

  await telegram.send(message);
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
  });

  // Initialize components
  const telegram = new TelegramNotifier(config.telegramBotToken, config.telegramChatId);

  if (config.brokerId === 'paper') {
    initPaperAccount(config.startingCapital);
  }
  setPeakEquity(config.startingCapital);

  // Load reference data
  await loadCikTickerMap();
  if (config.enableNetNet) {
    await loadScreenUniverse();
  }

  await telegram.send(
    `<b>Gecko v2 Online</b>\n` +
    `Mode: ${config.liveTrading ? 'LIVE' : 'PAPER'}\n` +
    `Capital: $${config.startingCapital}\n` +
    `Strategies: ${[
      config.enableNetNet && 'Net-Net',
      config.enableSpinoff && 'Spin-Off',
      config.enablePead && 'PEAD',
      config.enableRegSho && 'Reg SHO',
    ].filter(Boolean).join(', ')}`
  );

  log.info('System initialized. Starting agent loops.');

  // Get initial account state
  const getAccount = (): AccountState => {
    if (config.brokerId === 'paper') return getPaperAccountState();
    // For IBKR: would query account state here
    return getPaperAccountState(); // fallback
  };

  // Fast cycle: every 60 seconds
  const runFast = async (): Promise<void> => {
    try {
      await fastCycle(getAccount(), telegram, config);
    } catch (err) {
      log.error('Fast cycle error', { error: err instanceof Error ? err.message : String(err) });
    }
  };
  await runFast();
  setInterval(runFast, 60_000);

  // Slow cycle: every 30 minutes (net-net screening)
  const runSlow = async (): Promise<void> => {
    try {
      await slowCycle(getAccount(), telegram, config);
    } catch (err) {
      log.error('Slow cycle error', { error: err instanceof Error ? err.message : String(err) });
    }
  };
  setInterval(runSlow, 30 * 60_000);

  // Daily reset + report at midnight UTC
  const scheduleDailyReset = (): void => {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    const msUntilMidnight = midnight.getTime() - now.getTime();

    setTimeout(async () => {
      await sendDailyReport(telegram);
      resetDailyPnl();
      scheduleDailyReset();
    }, msUntilMidnight);
  };
  scheduleDailyReset();

  log.info('All agent loops running. Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
