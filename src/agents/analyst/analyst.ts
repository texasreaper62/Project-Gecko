/**
 * ANALYST: Claude-Powered Analysis Agent
 *
 * Takes opportunities from Scout, reasons about them using Claude,
 * and outputs typed StrategyActions.
 *
 * D0 Principle: "The model reasons freely in natural language.
 * The system executes typed actions."
 *
 * The Analyst NEVER sees the constraint rules. It proposes actions.
 * The Sentinel adjudicates.
 *
 * Uses Claude Haiku for fast triage, Sonnet for deep analysis.
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

const log = createLogger('analyst');

// ============================================================
// STRATEGY ACTION BUILDER
// ============================================================

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
// ANALYSIS FUNCTIONS (per strategy type)
// ============================================================

/**
 * Analyze a spin-off opportunity.
 * For now, uses rule-based analysis. Will be upgraded to Claude API.
 */
export function analyzeSpinoff(
  opp: Opportunity,
  account: AccountState
): StrategyAction | null {
  // Rule-based triage (will be replaced by Claude Haiku)
  // Spin-offs are bought as shares, held 3-6 months
  const equity = account.equity.value;
  const positionSize = Math.min(equity * 0.10, 600);

  if (positionSize < 100) return null;

  // Estimate a limit price (placeholder -- real system queries IBKR)
  const estimatedPrice = 25; // Will be replaced by live quote
  const quantity = Math.floor(positionSize / estimatedPrice);
  if (quantity < 1) return null;

  return buildAction({
    opportunityId: opp.id,
    strategy: 'spinoff',
    ticker: opp.ticker,
    side: 'BUY',
    instrumentType: 'SHARES',
    quantity,
    limitPrice: estimatedPrice,
    stopLoss: estimatedPrice * 0.90,     // 10% stop
    takeProfit: estimatedPrice * 1.25,   // 25% target
    maxHoldDays: 180,
    positionSizeDollars: positionSize,
    conviction: 70,                       // Base conviction for spin-offs
    rationale: `Spin-off detected: ${opp.summary}. Index funds likely dumping. Historical 7-10% excess return in first 12 months.`,
  });
}

/**
 * Analyze a Reg SHO forced covering opportunity.
 */
export function analyzeRegSho(
  opp: Opportunity,
  account: AccountState
): StrategyAction | null {
  const equity = account.equity.value;
  const positionSize = Math.min(equity * 0.08, 500);

  if (positionSize < 100) return null;

  const estimatedPrice = 20; // Placeholder
  const quantity = Math.floor(positionSize / estimatedPrice);
  if (quantity < 1) return null;

  // Check strategy track record
  const stats = getStrategyStats('reg_sho');
  let conviction = 65;
  if (stats.totalTrades >= 10) {
    // Adjust conviction based on track record
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
    limitPrice: estimatedPrice,
    stopLoss: estimatedPrice * 0.92,     // 8% stop
    takeProfit: estimatedPrice * 1.04,   // 4% target (forced covering pop)
    maxHoldDays: 10,
    positionSizeDollars: positionSize,
    conviction,
    rationale: `Reg SHO threshold list: ${opp.ticker}. Forced buy-to-cover within 13 days. ${JSON.stringify(opp.data)}`,
  });
}

/**
 * Analyze an insider cluster opportunity.
 */
export function analyzeInsiderCluster(
  opp: Opportunity,
  account: AccountState
): StrategyAction | null {
  const equity = account.equity.value;
  const positionSize = Math.min(equity * 0.08, 500);

  if (positionSize < 100) return null;

  const buyerCount = (opp.data.buyerCount as number) ?? 0;
  const isActivist = (opp.data.isActivist as boolean) ?? false;

  // Higher conviction for more buyers or activist involvement
  let conviction = 60;
  if (buyerCount >= 5) conviction = 80;
  else if (buyerCount >= 3) conviction = 70;
  if (isActivist) conviction = Math.min(conviction + 15, 90);

  const estimatedPrice = 30; // Placeholder
  const quantity = Math.floor(positionSize / estimatedPrice);
  if (quantity < 1) return null;

  return buildAction({
    opportunityId: opp.id,
    strategy: 'insider_cluster',
    ticker: opp.ticker,
    side: 'BUY',
    instrumentType: 'SHARES',
    quantity,
    limitPrice: estimatedPrice,
    stopLoss: estimatedPrice * 0.88,
    takeProfit: estimatedPrice * 1.15,
    maxHoldDays: 60,
    positionSizeDollars: positionSize,
    conviction,
    rationale: isActivist
      ? `Activist 13D filing: ${opp.summary}. Historical +5-7% abnormal return.`
      : `Insider cluster: ${buyerCount} insiders buying in 14 days. Historical +4-8% over 12 months.`,
  });
}

/**
 * Analyze a PEAD (post-earnings drift) opportunity.
 */
export function analyzePead(
  opp: Opportunity,
  account: AccountState
): StrategyAction | null {
  const equity = account.equity.value;
  const positionSize = Math.min(equity * 0.10, 600);
  if (positionSize < 100) return null;

  const direction = opp.data.direction as string;
  const surprisePercent = opp.data.surprisePercent as number;
  const side: ActionSide = direction === 'positive' ? 'BUY' : 'SELL';

  // Conviction scales with surprise magnitude
  let conviction = 55;
  if (Math.abs(surprisePercent) > 20) conviction = 70;
  else if (Math.abs(surprisePercent) > 15) conviction = 65;
  else if (Math.abs(surprisePercent) > 10) conviction = 60;

  // Adjust for track record
  const stats = getStrategyStats('pead');
  if (stats.totalTrades >= 10 && stats.winRate > 0.60) conviction += 5;
  if (stats.totalTrades >= 10 && stats.winRate < 0.45) conviction -= 10;

  const estimatedPrice = 50; // Placeholder - real system queries IBKR

  return buildAction({
    opportunityId: opp.id,
    strategy: 'pead',
    ticker: opp.ticker,
    side,
    instrumentType: 'DEBIT_SPREAD',
    quantity: Math.max(1, Math.floor(positionSize / 250)), // ~$250 per spread
    limitPrice: 2.50, // Spread cost placeholder
    stopLoss: 0, // Defined by spread max loss
    takeProfit: 4.50, // ~80% profit target on spread
    maxHoldDays: 45,
    positionSizeDollars: positionSize,
    conviction,
    rationale: `PEAD: ${opp.ticker} ${direction} surprise ${Math.abs(surprisePercent).toFixed(1)}%. Historical drift 2-3% over 60 days. Options amplification via debit spread.`,
    optionsExpiry: undefined, // Will be calculated from current date + 60 DTE
    spreadWidth: 5.00,
  });
}

/**
 * Analyze a net-net deep value opportunity.
 */
export function analyzeNetNet(
  opp: Opportunity,
  account: AccountState
): StrategyAction | null {
  const equity = account.equity.value;
  // Net-nets: smaller positions, more diversified (target 20 names)
  const positionSize = Math.min(equity * 0.05, 300);
  if (positionSize < 50) return null;

  const ncavPerShare = opp.data.ncavPerShare as number;
  if (!ncavPerShare || ncavPerShare <= 0) return null;

  // Base conviction for net-nets is moderate
  // The edge comes from diversification, not individual picks
  const conviction = 62;

  // Estimate limit price as 70% of NCAV (we want to buy BELOW NCAV)
  const limitPrice = ncavPerShare * 0.70;
  const quantity = Math.floor(positionSize / limitPrice);
  if (quantity < 1) return null;

  return buildAction({
    opportunityId: opp.id,
    strategy: 'net_net',
    ticker: opp.ticker,
    side: 'BUY',
    instrumentType: 'SHARES',
    quantity,
    limitPrice: Math.round(limitPrice * 100) / 100,
    stopLoss: limitPrice * 0.70, // 30% stop (net-nets can be volatile)
    takeProfit: ncavPerShare * 1.10, // Target: 10% above NCAV
    maxHoldDays: 365,
    positionSizeDollars: positionSize,
    conviction,
    rationale: `Net-net: ${opp.ticker} trading below NCAV. NCAV/share: $${ncavPerShare.toFixed(2)}. Buying at $${limitPrice.toFixed(2)} (70% of NCAV). Historical 20-25% annualized.`,
  });
}

/**
 * Analyze a material event (8-K filing).
 * Lower conviction since we can't read the filing content without Claude.
 */
export function analyzeFilingEvent(
  opp: Opportunity,
  account: AccountState
): StrategyAction | null {
  // Without Claude API, we can't properly analyze 8-K filings
  // Return null to skip, or low-conviction action if we want to flag for review
  log.info('8-K filing detected, needs Claude analysis for full evaluation', {
    ticker: opp.ticker,
    entity: opp.data.entityName,
  });
  return null;
}

// ============================================================
// MAIN ANALYSIS DISPATCH
// ============================================================

export function analyzeOpportunity(
  opp: Opportunity,
  account: AccountState
): StrategyAction | null {
  switch (opp.type) {
    case 'SPINOFF':
      return analyzeSpinoff(opp, account);
    case 'REG_SHO':
      return analyzeRegSho(opp, account);
    case 'INSIDER_CLUSTER':
      return analyzeInsiderCluster(opp, account);
    case 'FILING_TONE_SHIFT':
      return analyzeFilingEvent(opp, account);
    case 'PEAD':
      return analyzePead(opp, account);
    case 'NET_NET':
      return analyzeNetNet(opp, account);
    default:
      log.warn('Unknown opportunity type', { type: opp.type });
      return null;
  }
}
