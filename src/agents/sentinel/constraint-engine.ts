/**
 * SENTINEL: Constraint Engine
 *
 * This is the core safety layer. It lives OUTSIDE the Analyst's
 * reasoning path. The model never sees these rules, thresholds,
 * or logic. It only receives verdicts: PASS, HOLD, REJECT, ESCALATE.
 *
 * D0 Principle: "If the model can see the rule, it can optimize around it."
 *
 * The constraint engine validates StrategyActions against:
 * 1. Position sizing limits
 * 2. Portfolio exposure limits
 * 3. Daily loss limits
 * 4. Strategy-level kill switches
 * 5. Freshness of underlying state
 * 6. Concentration limits
 * 7. Account-level circuit breakers
 */

import type {
  StrategyAction,
  Verdict,
  VerdictType,
  AccountState,
  VerifiedFact,
} from '../../core/types.js';
import { isFresh } from '../../core/types.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('sentinel');

// ============================================================
// CONSTRAINT RULES -- The model NEVER sees these values
// ============================================================

interface ConstraintConfig {
  // Position sizing
  maxPositionPercent: number;      // Max % of equity per trade
  maxPositionDollars: number;      // Hard dollar cap per trade
  // Portfolio limits
  maxDeployedPercent: number;      // Max % of equity deployed
  maxConcurrentPositions: number;  // Hard cap on open positions
  maxSectorPercent: number;        // Max % in any one sector
  // Loss limits
  dailyLossLimitPercent: number;   // Stop trading after this % daily loss
  strategyLossLimitDollars: number;// Kill strategy after this cumulative loss
  accountDrawdownHalt: number;     // Cut sizes 50% after this drawdown from peak
  accountRuinStop: number;         // Stop everything at this drawdown
  // Quality gates
  minConviction: number;           // Minimum analyst conviction to trade
  requireFreshState: boolean;      // Reject if account state is stale
  // Strategy-level kill switches (populated by Sentinel from trade history)
  disabledStrategies: Set<string>;
}

// These values are HARDCODED. Not in .env. Not in the prompt.
// The model cannot negotiate them.
const CONSTRAINTS: ConstraintConfig = {
  maxPositionPercent: 0.12,
  maxPositionDollars: 2500,
  maxDeployedPercent: 0.60,
  maxConcurrentPositions: 8,
  maxSectorPercent: 0.30,
  dailyLossLimitPercent: 0.03,
  strategyLossLimitDollars: 500,
  accountDrawdownHalt: 0.20,
  accountRuinStop: 0.40,
  minConviction: 60,
  requireFreshState: true,
  disabledStrategies: new Set(),
};

// Strategy-level cumulative P&L tracking
const strategyPnl: Map<string, number> = new Map();
let peakEquity = 0;

// ============================================================
// CONSTRAINT CHECKS
// ============================================================

type ConstraintCheck = (
  action: StrategyAction,
  account: AccountState
) => { passed: boolean; reason: string };

const checks: Array<{ name: string; check: ConstraintCheck }> = [
  {
    name: 'state_freshness',
    check: (_action, account) => {
      if (!CONSTRAINTS.requireFreshState) return { passed: true, reason: 'freshness check disabled' };
      if (!isFresh(account.equity)) return { passed: false, reason: 'account equity state is stale' };
      if (!isFresh(account.openPositions)) return { passed: false, reason: 'position state is stale' };
      return { passed: true, reason: 'state is fresh' };
    },
  },
  {
    name: 'strategy_enabled',
    check: (action) => {
      if (CONSTRAINTS.disabledStrategies.has(action.strategy)) {
        return { passed: false, reason: `strategy '${action.strategy}' is disabled (kill switch)` };
      }
      return { passed: true, reason: 'strategy is enabled' };
    },
  },
  {
    name: 'min_conviction',
    check: (action) => {
      if (action.conviction < CONSTRAINTS.minConviction) {
        return { passed: false, reason: `conviction ${action.conviction} below minimum ${CONSTRAINTS.minConviction}` };
      }
      return { passed: true, reason: `conviction ${action.conviction} meets minimum` };
    },
  },
  {
    name: 'position_size_percent',
    check: (action, account) => {
      const equity = account.equity.value;
      const pct = action.positionSizeDollars / equity;
      if (pct > CONSTRAINTS.maxPositionPercent) {
        return { passed: false, reason: `position ${(pct * 100).toFixed(1)}% exceeds max ${(CONSTRAINTS.maxPositionPercent * 100)}%` };
      }
      return { passed: true, reason: `position size ${(pct * 100).toFixed(1)}% within limits` };
    },
  },
  {
    name: 'position_size_dollars',
    check: (action) => {
      if (action.positionSizeDollars > CONSTRAINTS.maxPositionDollars) {
        return { passed: false, reason: `$${action.positionSizeDollars} exceeds max $${CONSTRAINTS.maxPositionDollars}` };
      }
      return { passed: true, reason: `$${action.positionSizeDollars} within dollar cap` };
    },
  },
  {
    name: 'portfolio_exposure',
    check: (action, account) => {
      const equity = account.equity.value;
      const currentDeployed = account.openPositions.value.reduce(
        (sum, p) => sum + Math.abs(p.quantity * p.currentPrice), 0
      );
      const newDeployed = currentDeployed + action.positionSizeDollars;
      const pct = newDeployed / equity;
      if (pct > CONSTRAINTS.maxDeployedPercent) {
        return { passed: false, reason: `total deployed ${(pct * 100).toFixed(1)}% exceeds max ${(CONSTRAINTS.maxDeployedPercent * 100)}%` };
      }
      return { passed: true, reason: `total deployed ${(pct * 100).toFixed(1)}% within limits` };
    },
  },
  {
    name: 'max_concurrent',
    check: (_action, account) => {
      const count = account.openPositions.value.length;
      if (count >= CONSTRAINTS.maxConcurrentPositions) {
        return { passed: false, reason: `${count} positions open, max is ${CONSTRAINTS.maxConcurrentPositions}` };
      }
      return { passed: true, reason: `${count} positions open, room for more` };
    },
  },
  {
    name: 'daily_loss_limit',
    check: (_action, account) => {
      const equity = account.equity.value;
      const dailyLoss = account.dailyPnl.value;
      const limitDollars = equity * CONSTRAINTS.dailyLossLimitPercent;
      if (dailyLoss < -limitDollars) {
        return { passed: false, reason: `daily loss $${Math.abs(dailyLoss).toFixed(2)} exceeds limit $${limitDollars.toFixed(2)}` };
      }
      return { passed: true, reason: `daily P&L $${dailyLoss.toFixed(2)} within limits` };
    },
  },
  {
    name: 'strategy_kill_switch',
    check: (action) => {
      const cumPnl = strategyPnl.get(action.strategy) ?? 0;
      if (cumPnl < -CONSTRAINTS.strategyLossLimitDollars) {
        return { passed: false, reason: `strategy '${action.strategy}' cumulative loss $${Math.abs(cumPnl).toFixed(2)} exceeds kill threshold` };
      }
      return { passed: true, reason: `strategy cumulative P&L $${cumPnl.toFixed(2)} within limits` };
    },
  },
  {
    name: 'account_drawdown',
    check: (_action, account) => {
      const equity = account.equity.value;
      if (equity > peakEquity) peakEquity = equity;
      const drawdown = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      if (drawdown >= CONSTRAINTS.accountRuinStop) {
        return { passed: false, reason: `account drawdown ${(drawdown * 100).toFixed(1)}% hit ruin stop` };
      }
      if (drawdown >= CONSTRAINTS.accountDrawdownHalt) {
        return { passed: false, reason: `account drawdown ${(drawdown * 100).toFixed(1)}% hit halt level -- reduce sizes` };
      }
      return { passed: true, reason: `drawdown ${(drawdown * 100).toFixed(1)}% within limits` };
    },
  },
  {
    name: 'has_stop_loss',
    check: (action) => {
      if (action.stopLoss <= 0) {
        return { passed: false, reason: 'no stop loss defined' };
      }
      return { passed: true, reason: 'stop loss defined' };
    },
  },
  {
    name: 'no_duplicate_position',
    check: (action, account) => {
      const existing = account.openPositions.value.find(
        p => p.symbol === action.ticker && p.strategy === action.strategy
      );
      if (existing) {
        return { passed: false, reason: `already have ${action.ticker} position from ${action.strategy}` };
      }
      return { passed: true, reason: 'no duplicate position' };
    },
  },
];

// ============================================================
// MAIN ADJUDICATION FUNCTION
// ============================================================

export function adjudicate(action: StrategyAction, account: AccountState): Verdict {
  const passed: string[] = [];
  const failed: string[] = [];
  const reasons: string[] = [];

  for (const { name, check } of checks) {
    const result = check(action, account);
    if (result.passed) {
      passed.push(name);
    } else {
      failed.push(name);
      reasons.push(result.reason);
    }
  }

  let verdictType: VerdictType;
  if (failed.length === 0) {
    verdictType = 'PASS';
  } else if (failed.includes('state_freshness')) {
    verdictType = 'SUSPEND'; // Wait for fresh state
  } else if (failed.includes('account_drawdown') && reasons.some(r => r.includes('ruin'))) {
    verdictType = 'REJECT'; // Hard stop, no negotiation
  } else if (failed.includes('daily_loss_limit') || failed.includes('strategy_kill_switch')) {
    verdictType = 'REJECT'; // Risk limits breached
  } else if (failed.includes('min_conviction')) {
    verdictType = 'HOLD'; // Maybe try again with more data
  } else {
    verdictType = 'REJECT';
  }

  const verdict: Verdict = {
    type: verdictType,
    action,
    reasons,
    timestamp: Date.now(),
    constraintsFailed: failed,
    constraintsPassed: passed,
  };

  log.info(`Verdict: ${verdictType}`, {
    actionId: action.id,
    ticker: action.ticker,
    strategy: action.strategy,
    passed: passed.length,
    failed: failed.length,
    reasons,
  });

  return verdict;
}

// ============================================================
// STRATEGY P&L TRACKING (fed by Recorder)
// ============================================================

export function recordStrategyPnl(strategy: string, pnl: number): void {
  const current = strategyPnl.get(strategy) ?? 0;
  strategyPnl.set(strategy, current + pnl);

  // Auto-disable strategy if it hits the kill threshold
  if (current + pnl < -CONSTRAINTS.strategyLossLimitDollars) {
    CONSTRAINTS.disabledStrategies.add(strategy);
    log.warn(`Strategy '${strategy}' auto-disabled: cumulative loss $${Math.abs(current + pnl).toFixed(2)}`);
  }
}

export function getStrategyPnl(strategy: string): number {
  return strategyPnl.get(strategy) ?? 0;
}

export function isStrategyEnabled(strategy: string): boolean {
  return !CONSTRAINTS.disabledStrategies.has(strategy);
}

export function enableStrategy(strategy: string): void {
  CONSTRAINTS.disabledStrategies.delete(strategy);
  log.info(`Strategy '${strategy}' re-enabled`);
}

export function setPeakEquity(equity: number): void {
  if (equity > peakEquity) peakEquity = equity;
}
