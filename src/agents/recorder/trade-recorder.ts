/**
 * RECORDER: Trade Recording and Closed-Loop Feedback
 *
 * Records every step of the pipeline:
 * - Opportunities detected (by Scout)
 * - Actions proposed (by Analyst)
 * - Verdicts issued (by Sentinel)
 * - Executions completed (by Executor)
 * - Trade outcomes (entry -> exit -> P&L)
 *
 * This is the feedback loop. Verified outcomes feed back into:
 * - Strategy P&L tracking (for Sentinel kill switches)
 * - Win rate tracking (for Analyst context)
 * - Performance attribution (for strategy weight adjustment)
 */

import type {
  Opportunity,
  StrategyAction,
  Verdict,
  ExecutionResult,
  TradeRecord,
} from '../../core/types.js';
import { appendJsonl, readJsonl } from '../../utils/persistence.js';
import { createLogger } from '../../core/logger.js';
import { recordStrategyPnl } from '../sentinel/constraint-engine.js';

const log = createLogger('recorder');

const DATA_DIR = 'data';
const OPPORTUNITIES_FILE = `${DATA_DIR}/opportunities.jsonl`;
const ACTIONS_FILE = `${DATA_DIR}/actions.jsonl`;
const VERDICTS_FILE = `${DATA_DIR}/verdicts.jsonl`;
const EXECUTIONS_FILE = `${DATA_DIR}/executions.jsonl`;
const TRADES_FILE = `${DATA_DIR}/trades.jsonl`;
const DAILY_SUMMARY_FILE = `${DATA_DIR}/daily-summary.jsonl`;

// ============================================================
// RECORD EVENTS
// ============================================================

export function recordOpportunity(opp: Opportunity): void {
  appendJsonl(OPPORTUNITIES_FILE, { ...opp, recordedAt: Date.now() });
  log.debug('Recorded opportunity', { id: opp.id, type: opp.type, ticker: opp.ticker });
}

export function recordAction(action: StrategyAction): void {
  appendJsonl(ACTIONS_FILE, { ...action, recordedAt: Date.now() });
  log.debug('Recorded action', { id: action.id, ticker: action.ticker, strategy: action.strategy });
}

export function recordVerdict(verdict: Verdict): void {
  appendJsonl(VERDICTS_FILE, {
    type: verdict.type,
    actionId: verdict.action.id,
    ticker: verdict.action.ticker,
    strategy: verdict.action.strategy,
    reasons: verdict.reasons,
    constraintsFailed: verdict.constraintsFailed,
    constraintsPassed: verdict.constraintsPassed,
    timestamp: verdict.timestamp,
    recordedAt: Date.now(),
  });
  log.debug('Recorded verdict', { type: verdict.type, actionId: verdict.action.id });
}

export function recordExecution(result: ExecutionResult): void {
  appendJsonl(EXECUTIONS_FILE, { ...result, recordedAt: Date.now() });
  log.info('Recorded execution', {
    actionId: result.actionId,
    status: result.status,
    filledPrice: result.filledPrice,
    slippage: result.slippage,
  });
}

export function recordTrade(trade: TradeRecord): void {
  appendJsonl(TRADES_FILE, { ...trade, recordedAt: Date.now() });

  // Feed back to Sentinel for strategy P&L tracking
  recordStrategyPnl(trade.strategy, trade.pnlDollars);

  log.info('Recorded closed trade', {
    id: trade.id,
    ticker: trade.ticker,
    strategy: trade.strategy,
    pnl: trade.pnlDollars,
    exitReason: trade.exitReason,
  });
}

// ============================================================
// READ HISTORY (for Analyst context and performance tracking)
// ============================================================

export function getTradeHistory(limit: number = 100): TradeRecord[] {
  const all = readJsonl<TradeRecord>(TRADES_FILE);
  return all.slice(-limit);
}

export function getStrategyStats(strategy: string): {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
} {
  const trades = readJsonl<TradeRecord>(TRADES_FILE).filter(
    t => t.strategy === strategy
  );

  const wins = trades.filter(t => t.pnlDollars > 0);
  const losses = trades.filter(t => t.pnlDollars <= 0);
  const grossWins = wins.reduce((s, t) => s + t.pnlDollars, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnlDollars, 0));

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    totalPnl: trades.reduce((s, t) => s + t.pnlDollars, 0),
    avgWin: wins.length > 0 ? grossWins / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLosses / losses.length : 0,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
  };
}

export function getRecentVerdicts(limit: number = 50): Array<{
  type: string;
  actionId: string;
  ticker: string;
  strategy: string;
  reasons: string[];
  timestamp: number;
}> {
  const all = readJsonl<{
    type: string;
    actionId: string;
    ticker: string;
    strategy: string;
    reasons: string[];
    timestamp: number;
  }>(VERDICTS_FILE);
  return all.slice(-limit);
}

// ============================================================
// DAILY SUMMARY (for Telegram report)
// ============================================================

export function generateDailySummary(): {
  date: string;
  totalTrades: number;
  wins: number;
  losses: number;
  pnl: number;
  strategySummary: Record<string, { trades: number; pnl: number }>;
  verdictSummary: Record<string, number>;
} {
  const today = new Date().toISOString().split('T')[0];
  const todayStart = new Date(today).getTime();

  const trades = readJsonl<TradeRecord>(TRADES_FILE).filter(
    t => t.exitTimestamp >= todayStart
  );

  const verdicts = readJsonl<{ type: string; timestamp: number }>(VERDICTS_FILE).filter(
    v => v.timestamp >= todayStart
  );

  const strategySummary: Record<string, { trades: number; pnl: number }> = {};
  for (const t of trades) {
    if (!strategySummary[t.strategy]) {
      strategySummary[t.strategy] = { trades: 0, pnl: 0 };
    }
    strategySummary[t.strategy].trades++;
    strategySummary[t.strategy].pnl += t.pnlDollars;
  }

  const verdictSummary: Record<string, number> = {};
  for (const v of verdicts) {
    verdictSummary[v.type] = (verdictSummary[v.type] ?? 0) + 1;
  }

  const summary = {
    date: today,
    totalTrades: trades.length,
    wins: trades.filter(t => t.pnlDollars > 0).length,
    losses: trades.filter(t => t.pnlDollars <= 0).length,
    pnl: Math.round(trades.reduce((s, t) => s + t.pnlDollars, 0) * 100) / 100,
    strategySummary,
    verdictSummary,
  };

  appendJsonl(DAILY_SUMMARY_FILE, summary);
  return summary;
}
