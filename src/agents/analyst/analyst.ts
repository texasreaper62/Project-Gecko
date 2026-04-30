/**
 * ANALYST: Analysis Agent
 *
 * Takes opportunities from Scout, analyzes them, outputs typed StrategyActions.
 *
 * Two modes:
 * - Rule-based (fast, always available, fallback)
 * - Claude-powered (deep analysis when API key is configured)
 *
 * The Analyst NEVER sees the constraint rules. It proposes actions.
 * The Sentinel adjudicates.
 */

import type {
  Opportunity,
  StrategyAction,
  AccountState,
  ActionSide,
  InstrumentType,
} from '../../core/types.js';
import { createLogger } from '../../core/logger.js';
import { getStrategyStats } from '../recorder/trade-recorder.js';
import { getQuote } from '../../feeds/market-data.js';
import { analyzeWithClaude } from './claude-client.js';

const log = createLogger('analyst');

let actionCounter = 0;

function buildAction(params: {
  opportunityId: string;
  strategy: string;
  ticker: string;
  side: ActionSide;
  instrumentType: InstrumentType;
  quantity: number;
  limitPrice: number;
  stopLoss: number;
  takeProfit: number;
  maxHoldDays: number;
  positionSizeDollars: number;
  conviction: number;
  rationale: string;
  optionsExpiry?: string;
  optionsStrike?: number;
  spreadWidth?: number;
}): StrategyAction {
  return {
    id: `action-${++actionCounter}-${Date.now()}`,
    timestamp: Date.now(),
    ...params,
  };
}

// ============================================================
// LIVE PRICE LOOKUP
// ============================================================

async function getLivePrice(ticker: string): Promise<number | null> {
  const quote = await getQuote(ticker);
  if (!quote) return null;
  return quote.value.price;
}

// ============================================================
// STRATEGY ANALYSIS FUNCTIONS
// ============================================================

async function analyzeSpinoff(
  opp: Opportunity,
  account: AccountState
): Promise<StrategyAction | null> {
  const equity = account.equity.value;
  const positionSize = Math.min(equity * 0.10, equity * 0.12);

  if (positionSize < 200) return null;

  const price = await getLivePrice(opp.ticker);
  if (!price) {
    log.info('No live price for spin-off, skipping', { ticker: opp.ticker });
    return null;
  }

  const quantity = Math.floor(positionSize / price);
  if (quantity < 1) return null;

  return buildAction({
    opportunityId: opp.id,
    strategy: 'spinoff',
    ticker: opp.ticker,
    side: 'BUY',
    instrumentType: 'SHARES',
    quantity,
    limitPrice: price,
    stopLoss: Math.round(price * 0.90 * 100) / 100,
    takeProfit: Math.round(price * 1.25 * 100) / 100,
    maxHoldDays: 180,
    positionSizeDollars: Math.round(quantity * price * 100) / 100,
    conviction: 70,
    rationale: `Spin-off detected: ${opp.summary}. Index funds likely dumping. Current price $${price.toFixed(2)}.`,
  });
}

async function analyzeRegSho(
  opp: Opportunity,
  account: AccountState
): Promise<StrategyAction | null> {
  const equity = account.equity.value;
  const positionSize = Math.min(equity * 0.08, equity * 0.10);

  if (positionSize < 200) return null;

  const price = await getLivePrice(opp.ticker);
  if (!price) {
    log.info('No live price for Reg SHO stock, skipping', { ticker: opp.ticker });
    return null;
  }

  const quantity = Math.floor(positionSize / price);
  if (quantity < 1) return null;

  const stats = getStrategyStats('reg_sho');
  let conviction = 65;
  if (stats.totalTrades >= 10) {
    if (stats.winRate > 0.60) conviction = 75;
    else if (stats.winRate < 0.45) conviction = 50;
  }

  return buildAction({
    opportunityId: opp.id,
    strategy: 'reg_sho',
    ticker: opp.ticker,
    side: 'BUY',
    instrumentType: 'SHARES',
    quantity,
    limitPrice: price,
    stopLoss: Math.round(price * 0.92 * 100) / 100,
    takeProfit: Math.round(price * 1.04 * 100) / 100,
    maxHoldDays: 10,
    positionSizeDollars: Math.round(quantity * price * 100) / 100,
    conviction,
    rationale: `Reg SHO: ${opp.ticker} at $${price.toFixed(2)}. Forced buy-to-cover within 13 days.`,
  });
}

async function analyzeInsiderCluster(
  opp: Opportunity,
  account: AccountState
): Promise<StrategyAction | null> {
  const equity = account.equity.value;
  const positionSize = Math.min(equity * 0.08, equity * 0.10);

  if (positionSize < 200) return null;

  const price = await getLivePrice(opp.ticker);
  if (!price) return null;

  const buyerCount = (opp.data.buyerCount as number) ?? 0;
  const isActivist = (opp.data.isActivist as boolean) ?? false;

  let conviction = 60;
  if (buyerCount >= 5) conviction = 80;
  else if (buyerCount >= 3) conviction = 70;
  if (isActivist) conviction = Math.min(conviction + 15, 90);

  const quantity = Math.floor(positionSize / price);
  if (quantity < 1) return null;

  return buildAction({
    opportunityId: opp.id,
    strategy: 'insider_cluster',
    ticker: opp.ticker,
    side: 'BUY',
    instrumentType: 'SHARES',
    quantity,
    limitPrice: price,
    stopLoss: Math.round(price * 0.88 * 100) / 100,
    takeProfit: Math.round(price * 1.15 * 100) / 100,
    maxHoldDays: 60,
    positionSizeDollars: Math.round(quantity * price * 100) / 100,
    conviction,
    rationale: isActivist
      ? `Activist 13D: ${opp.summary}. Price $${price.toFixed(2)}.`
      : `Insider cluster: ${buyerCount} buyers in 14 days. Price $${price.toFixed(2)}.`,
  });
}

async function analyzePead(
  opp: Opportunity,
  account: AccountState
): Promise<StrategyAction | null> {
  const equity = account.equity.value;
  const positionSize = Math.min(equity * 0.10, equity * 0.12);
  if (positionSize < 300) return null;

  const price = await getLivePrice(opp.ticker);
  if (!price) return null;

  const direction = opp.data.direction as string;
  const surprisePercent = opp.data.surprisePercent as number;
  const side: ActionSide = direction === 'positive' ? 'BUY' : 'SELL';

  let conviction = 55;
  if (Math.abs(surprisePercent) > 20) conviction = 70;
  else if (Math.abs(surprisePercent) > 15) conviction = 65;
  else if (Math.abs(surprisePercent) > 10) conviction = 60;

  const stats = getStrategyStats('pead');
  if (stats.totalTrades >= 10 && stats.winRate > 0.60) conviction += 5;
  if (stats.totalTrades >= 10 && stats.winRate < 0.45) conviction -= 10;

  // For debit spreads: estimate cost as ~$3 per spread, 2 spreads per $1500 allocation
  const spreadCost = 3.00;
  const numSpreads = Math.max(1, Math.floor(positionSize / (spreadCost * 100)));

  return buildAction({
    opportunityId: opp.id,
    strategy: 'pead',
    ticker: opp.ticker,
    side,
    instrumentType: 'DEBIT_SPREAD',
    quantity: numSpreads,
    limitPrice: spreadCost,
    stopLoss: 0,
    takeProfit: spreadCost * 1.80,
    maxHoldDays: 45,
    positionSizeDollars: Math.round(numSpreads * spreadCost * 100 * 100) / 100,
    conviction,
    rationale: `PEAD: ${opp.ticker} ${direction} surprise ${Math.abs(surprisePercent).toFixed(1)}%. Price $${price.toFixed(2)}. ${numSpreads} debit spreads.`,
    spreadWidth: 5.00,
  });
}

async function analyzeNetNet(
  opp: Opportunity,
  account: AccountState
): Promise<StrategyAction | null> {
  const equity = account.equity.value;
  const positionSize = Math.min(equity * 0.05, equity * 0.06);
  if (positionSize < 100) return null;

  const ncavPerShare = opp.data.ncavPerShare as number;
  if (!ncavPerShare || ncavPerShare <= 0) return null;

  const price = await getLivePrice(opp.ticker);
  if (!price) return null;

  // Only buy if price is below NCAV (that's the whole point)
  if (price >= ncavPerShare) {
    log.debug('Stock price above NCAV, not a net-net', {
      ticker: opp.ticker,
      price,
      ncav: ncavPerShare,
    });
    return null;
  }

  const quantity = Math.floor(positionSize / price);
  if (quantity < 1) return null;

  const discount = ((ncavPerShare - price) / ncavPerShare) * 100;

  return buildAction({
    opportunityId: opp.id,
    strategy: 'net_net',
    ticker: opp.ticker,
    side: 'BUY',
    instrumentType: 'SHARES',
    quantity,
    limitPrice: Math.round(price * 100) / 100,
    stopLoss: Math.round(price * 0.70 * 100) / 100,
    takeProfit: Math.round(ncavPerShare * 1.10 * 100) / 100,
    maxHoldDays: 365,
    positionSizeDollars: Math.round(quantity * price * 100) / 100,
    conviction: 62,
    rationale: `Net-net: ${opp.ticker} at $${price.toFixed(2)}, NCAV $${ncavPerShare.toFixed(2)} (${discount.toFixed(0)}% discount).`,
  });
}

// ============================================================
// MAIN ANALYSIS DISPATCH
// ============================================================

export async function analyzeOpportunity(
  opp: Opportunity,
  account: AccountState,
  claudeApiKey?: string
): Promise<StrategyAction | null> {
  // Try Claude first if configured (for supported types)
  if (claudeApiKey && ['SPINOFF', 'INSIDER_CLUSTER', 'FILING_TONE_SHIFT'].includes(opp.type)) {
    const claudeResult = await analyzeWithClaude(claudeApiKey, opp, account);
    if (claudeResult && claudeResult.shouldTrade) {
      const price = await getLivePrice(opp.ticker);
      if (!price) return null;

      const equity = account.equity.value;
      const positionSize = Math.min(equity * 0.10, equity * 0.12);
      const quantity = Math.floor(positionSize / price);
      if (quantity < 1) return null;

      const instrument: InstrumentType = claudeResult.instrumentPreference === 'OPTIONS'
        ? 'DEBIT_SPREAD' : 'SHARES';

      return buildAction({
        opportunityId: opp.id,
        strategy: opp.type.toLowerCase(),
        ticker: opp.ticker,
        side: claudeResult.side,
        instrumentType: instrument,
        quantity,
        limitPrice: price,
        stopLoss: Math.round(price * (1 - claudeResult.suggestedStopPercent) * 100) / 100,
        takeProfit: Math.round(price * (1 + claudeResult.suggestedTargetPercent) * 100) / 100,
        maxHoldDays: claudeResult.suggestedHoldDays,
        positionSizeDollars: Math.round(quantity * price * 100) / 100,
        conviction: claudeResult.conviction,
        rationale: claudeResult.rationale,
      });
    }
  }

  // Fallback to rule-based analysis
  switch (opp.type) {
    case 'SPINOFF':
      return analyzeSpinoff(opp, account);
    case 'REG_SHO':
      return analyzeRegSho(opp, account);
    case 'INSIDER_CLUSTER':
      return analyzeInsiderCluster(opp, account);
    case 'PEAD':
      return analyzePead(opp, account);
    case 'NET_NET':
      return analyzeNetNet(opp, account);
    case 'FILING_TONE_SHIFT':
      log.info('8-K filing needs Claude for analysis', { ticker: opp.ticker });
      return null;
    default:
      log.warn('Unknown opportunity type', { type: opp.type });
      return null;
  }
}
