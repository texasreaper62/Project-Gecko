/**
 * EXECUTOR: Paper Trading Simulator
 *
 * Simulates order execution with realistic fills for paper trading.
 * Replaces IBKR API in paper mode. Tracks positions, fills, P&L.
 *
 * When LIVE_TRADING=true, this gets swapped for the IBKR executor.
 */

import type {
  StrategyAction,
  ExecutionResult,
  Position,
  AccountState,
  TradeRecord,
  FillStatus,
} from '../../core/types.js';
import { createFact } from '../../core/types.js';
import { createLogger } from '../../core/logger.js';
import { appendJsonl } from '../../utils/persistence.js';
import { recordExecution, recordTrade } from '../recorder/trade-recorder.js';

const log = createLogger('executor-paper');

// ============================================================
// PAPER ACCOUNT STATE
// ============================================================

let equity: number;
let positions: Position[] = [];
let dailyPnl = 0;
let orderIdCounter = 0;
let tradeIdCounter = 0;

export function initPaperAccount(startingCapital: number): void {
  equity = startingCapital;
  positions = [];
  dailyPnl = 0;
  log.info('Paper account initialized', { equity });
}

export function getPaperAccountState(): AccountState {
  return {
    equity: createFact(equity, 'paper', 'verified', 60_000),
    buyingPower: createFact(equity * 2, 'paper', 'verified', 60_000),
    openPositions: createFact(positions, 'paper', 'verified', 60_000),
    dailyPnl: createFact(dailyPnl, 'paper', 'verified', 60_000),
    pendingOrders: createFact([], 'paper', 'verified', 60_000),
  };
}

// ============================================================
// ORDER EXECUTION
// ============================================================

export function executeAction(action: StrategyAction): ExecutionResult {
  const orderId = `paper-${++orderIdCounter}`;

  // Simulate fill with realistic slippage
  const slippageBps = action.instrumentType === 'SHARES'
    ? 5 + Math.random() * 10    // 5-15 bps on shares
    : 20 + Math.random() * 30;  // 20-50 bps on options
  const slippagePercent = slippageBps / 10000;
  const slippage = action.limitPrice * slippagePercent;

  const filledPrice = action.side === 'BUY'
    ? action.limitPrice + slippage   // Pay slightly more when buying
    : action.limitPrice - slippage;  // Receive slightly less when selling

  // Simulate commission
  const commission = action.instrumentType === 'SHARES'
    ? 0  // IBKR zero commission on US stocks
    : Math.max(0.65 * action.quantity, 1.00);  // $0.65/contract min $1.00

  const result: ExecutionResult = {
    actionId: action.id,
    orderId,
    status: 'filled',
    filledQuantity: action.quantity,
    filledPrice: Math.round(filledPrice * 100) / 100,
    commission: Math.round(commission * 100) / 100,
    slippage: Math.round(slippage * 100) / 100,
    timestamp: Date.now(),
    venueResponse: 'PAPER_FILL',
  };

  // Update paper account
  const cost = filledPrice * action.quantity + commission;

  if (action.side === 'BUY') {
    equity -= cost;
    positions.push({
      symbol: action.ticker,
      side: 'long',
      quantity: action.quantity,
      avgCost: filledPrice,
      currentPrice: filledPrice,
      unrealizedPnl: -commission,
      strategy: action.strategy,
      entryTimestamp: Date.now(),
    });
  }

  recordExecution(result);

  log.info('Paper order filled', {
    orderId,
    ticker: action.ticker,
    side: action.side,
    quantity: action.quantity,
    filledPrice: result.filledPrice,
    commission: result.commission,
    slippage: result.slippage,
  });

  return result;
}

// ============================================================
// POSITION MANAGEMENT
// ============================================================

export function checkPositionExits(): TradeRecord[] {
  const closedTrades: TradeRecord[] = [];

  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    const holdDays = (Date.now() - pos.entryTimestamp) / (24 * 60 * 60 * 1000);

    // Simulate price movement (random walk for paper trading)
    // In production, this would query IBKR for current price
    const dailyReturn = (Math.random() - 0.48) * 0.02; // Slight positive bias
    const newPrice = pos.currentPrice * (1 + dailyReturn);

    // Check stop loss (using avgCost as reference since we don't store the action's stops here)
    const pnlPercent = (newPrice - pos.avgCost) / pos.avgCost;
    let exitReason: TradeRecord['exitReason'] | null = null;

    if (pnlPercent <= -0.08) {
      exitReason = 'stop';
    } else if (pnlPercent >= 0.15) {
      exitReason = 'target';
    } else if (holdDays >= 60) {
      exitReason = 'time';
    }

    if (exitReason) {
      const pnlDollars = (newPrice - pos.avgCost) * pos.quantity;
      const commission = pos.quantity > 0 ? 0 : 1.00; // shares = free, options = $1

      const trade: TradeRecord = {
        id: `trade-${++tradeIdCounter}`,
        opportunityId: '',
        actionId: '',
        strategy: pos.strategy,
        ticker: pos.symbol,
        side: 'BUY',
        instrumentType: 'SHARES',
        entryPrice: pos.avgCost,
        entryTimestamp: pos.entryTimestamp,
        entryConviction: 0,
        exitPrice: Math.round(newPrice * 100) / 100,
        exitTimestamp: Date.now(),
        exitReason,
        pnlDollars: Math.round(pnlDollars * 100) / 100,
        pnlPercent: Math.round(pnlPercent * 1000) / 10,
        holdDays: Math.round(holdDays * 10) / 10,
        commissions: commission,
        analystRationale: '',
        verdictType: 'PASS',
        constraintsFailed: [],
      };

      // Update equity
      equity += pos.avgCost * pos.quantity + pnlDollars - commission;
      dailyPnl += pnlDollars;

      // Remove position
      positions.splice(i, 1);

      recordTrade(trade);
      closedTrades.push(trade);

      log.info('Paper position closed', {
        ticker: pos.symbol,
        strategy: pos.strategy,
        exitReason,
        pnl: trade.pnlDollars,
        holdDays: trade.holdDays,
      });
    }
  }

  return closedTrades;
}

export function resetDailyPnl(): void {
  dailyPnl = 0;
}

export function getEquity(): number {
  return equity;
}

export function getPositionCount(): number {
  return positions.length;
}
