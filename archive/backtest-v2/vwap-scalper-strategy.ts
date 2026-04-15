/**
 * VWAP Mean Reversion Scalping Strategy for backtesting.
 *
 * Rules:
 * 1. Only trade during first 2 hours of RTH (minutes 0-119)
 * 2. Wait for VWAP to establish (skip first 5 minutes)
 * 3. Enter LONG when price drops X points below VWAP
 * 4. Enter SHORT when price rises X points above VWAP
 * 5. Target: reversion to VWAP (or partial: 60% of deviation)
 * 6. Stop: deviation expands by stop_multiple of entry deviation
 * 7. Max hold: 30 minutes, then exit at market
 * 8. Max 1 position at a time
 * 9. Daily loss limit: stop trading after $150 loss
 *
 * The key test: does this produce $75+/day on positive GEX days?
 */

import { MinuteBar, TradingDay } from './market-model.js';

interface ScalpTrade {
  entryMinute: number;
  exitMinute: number;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  entryDeviation: number;    // How far from VWAP at entry
  pnlPoints: number;
  pnlDollars: number;        // At $5/point for MES
  exitReason: 'target' | 'stop' | 'time' | 'daily_limit' | 'session_end';
}

interface DayResult {
  date: string;
  regime: string;
  trades: ScalpTrade[];
  totalPnlPoints: number;
  totalPnlDollars: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  maxDrawdownIntraday: number;
  hitDailyLimit: boolean;
}

interface StrategyParams {
  entryDeviation: number;      // Points from VWAP to trigger entry (e.g., 0.80 = $0.80 on SPY)
  targetPercent: number;       // Fraction of deviation to capture (e.g., 0.6 = 60% reversion)
  stopMultiple: number;        // Stop at entry deviation * this (e.g., 1.5 = 50% wider)
  maxHoldBars: number;         // Max minutes to hold (e.g., 30)
  maxTradingMinute: number;    // Last minute to enter (e.g., 119 = first 2 hours only)
  minTradingMinute: number;    // First minute to trade (e.g., 5 = skip first 5 min)
  dailyLossLimit: number;      // $ loss to stop for the day (e.g., -150)
  pointValue: number;          // $/point (MES=5, SPY shares=1 per share)
  contracts: number;           // Number of MES contracts or SPY shares
  commissionPerTrade: number;  // Round-trip commission
}

export function runVwapScalper(
  days: TradingDay[],
  params: StrategyParams
): DayResult[] {
  const results: DayResult[] = [];

  for (const day of days) {
    const trades: ScalpTrade[] = [];
    let dailyPnl = 0;
    let hitLimit = false;
    let inPosition = false;
    let posDir: 'long' | 'short' = 'long';
    let posEntry = 0;
    let posEntryMin = 0;
    let posEntryDev = 0;
    let posStop = 0;
    let posTarget = 0;
    let maxEquity = 0;
    let minEquity = 0;

    for (let i = 0; i < day.bars.length; i++) {
      const bar = day.bars[i];

      // Check daily loss limit
      if (dailyPnl <= params.dailyLossLimit) {
        hitLimit = true;
        if (inPosition) {
          // Force close
          const pnl = posDir === 'long'
            ? (bar.close - posEntry) * params.contracts
            : (posEntry - bar.close) * params.contracts;
          const pnlDollars = pnl * params.pointValue - params.commissionPerTrade;
          dailyPnl += pnlDollars;
          trades.push({
            entryMinute: posEntryMin, exitMinute: i, direction: posDir,
            entryPrice: posEntry, exitPrice: bar.close,
            entryDeviation: posEntryDev,
            pnlPoints: pnl, pnlDollars,
            exitReason: 'daily_limit'
          });
          inPosition = false;
        }
        break;
      }

      // Manage open position
      if (inPosition) {
        const barsHeld = i - posEntryMin;

        // Check stop
        if (posDir === 'long' && bar.low <= posStop) {
          const pnl = (posStop - posEntry) * params.contracts;
          const pnlDollars = pnl * params.pointValue - params.commissionPerTrade;
          dailyPnl += pnlDollars;
          trades.push({
            entryMinute: posEntryMin, exitMinute: i, direction: posDir,
            entryPrice: posEntry, exitPrice: posStop,
            entryDeviation: posEntryDev,
            pnlPoints: pnl, pnlDollars, exitReason: 'stop'
          });
          inPosition = false;
          continue;
        }
        if (posDir === 'short' && bar.high >= posStop) {
          const pnl = (posEntry - posStop) * params.contracts;
          const pnlDollars = pnl * params.pointValue - params.commissionPerTrade;
          dailyPnl += pnlDollars;
          trades.push({
            entryMinute: posEntryMin, exitMinute: i, direction: posDir,
            entryPrice: posEntry, exitPrice: posStop,
            entryDeviation: posEntryDev,
            pnlPoints: pnl, pnlDollars, exitReason: 'stop'
          });
          inPosition = false;
          continue;
        }

        // Check target
        if (posDir === 'long' && bar.high >= posTarget) {
          const pnl = (posTarget - posEntry) * params.contracts;
          const pnlDollars = pnl * params.pointValue - params.commissionPerTrade;
          dailyPnl += pnlDollars;
          trades.push({
            entryMinute: posEntryMin, exitMinute: i, direction: posDir,
            entryPrice: posEntry, exitPrice: posTarget,
            entryDeviation: posEntryDev,
            pnlPoints: pnl, pnlDollars, exitReason: 'target'
          });
          inPosition = false;
          continue;
        }
        if (posDir === 'short' && bar.low <= posTarget) {
          const pnl = (posEntry - posTarget) * params.contracts;
          const pnlDollars = pnl * params.pointValue - params.commissionPerTrade;
          dailyPnl += pnlDollars;
          trades.push({
            entryMinute: posEntryMin, exitMinute: i, direction: posDir,
            entryPrice: posEntry, exitPrice: posTarget,
            entryDeviation: posEntryDev,
            pnlPoints: pnl, pnlDollars, exitReason: 'target'
          });
          inPosition = false;
          continue;
        }

        // Max hold time
        if (barsHeld >= params.maxHoldBars) {
          const pnl = posDir === 'long'
            ? (bar.close - posEntry) * params.contracts
            : (posEntry - bar.close) * params.contracts;
          const pnlDollars = pnl * params.pointValue - params.commissionPerTrade;
          dailyPnl += pnlDollars;
          trades.push({
            entryMinute: posEntryMin, exitMinute: i, direction: posDir,
            entryPrice: posEntry, exitPrice: bar.close,
            entryDeviation: posEntryDev,
            pnlPoints: pnl, pnlDollars, exitReason: 'time'
          });
          inPosition = false;
          continue;
        }

        // Session end (close before 2-hour window ends)
        if (i >= params.maxTradingMinute) {
          const pnl = posDir === 'long'
            ? (bar.close - posEntry) * params.contracts
            : (posEntry - bar.close) * params.contracts;
          const pnlDollars = pnl * params.pointValue - params.commissionPerTrade;
          dailyPnl += pnlDollars;
          trades.push({
            entryMinute: posEntryMin, exitMinute: i, direction: posDir,
            entryPrice: posEntry, exitPrice: bar.close,
            entryDeviation: posEntryDev,
            pnlPoints: pnl, pnlDollars, exitReason: 'session_end'
          });
          inPosition = false;
          break;
        }

        continue; // Still in position
      }

      // --- Entry logic ---
      if (i < params.minTradingMinute) continue;
      if (i >= params.maxTradingMinute) continue;

      const deviation = bar.close - bar.vwap;
      const absDeviation = Math.abs(deviation);

      if (absDeviation >= params.entryDeviation) {
        if (deviation > 0) {
          // Price above VWAP: SHORT
          posDir = 'short';
          posEntry = bar.close;
          posEntryMin = i;
          posEntryDev = absDeviation;
          posStop = posEntry + absDeviation * params.stopMultiple;
          posTarget = posEntry - absDeviation * params.targetPercent;
          inPosition = true;
        } else {
          // Price below VWAP: LONG
          posDir = 'long';
          posEntry = bar.close;
          posEntryMin = i;
          posEntryDev = absDeviation;
          posStop = posEntry - absDeviation * params.stopMultiple;
          posTarget = posEntry + absDeviation * params.targetPercent;
          inPosition = true;
        }
      }
    }

    // Force close any remaining position
    if (inPosition) {
      const lastBar = day.bars[Math.min(day.bars.length - 1, params.maxTradingMinute)];
      const pnl = posDir === 'long'
        ? (lastBar.close - posEntry) * params.contracts
        : (posEntry - lastBar.close) * params.contracts;
      const pnlDollars = pnl * params.pointValue - params.commissionPerTrade;
      dailyPnl += pnlDollars;
      trades.push({
        entryMinute: posEntryMin, exitMinute: params.maxTradingMinute,
        direction: posDir, entryPrice: posEntry, exitPrice: lastBar.close,
        entryDeviation: posEntryDev,
        pnlPoints: pnl, pnlDollars, exitReason: 'session_end'
      });
    }

    const wins = trades.filter(t => t.pnlDollars > 0);
    const losses = trades.filter(t => t.pnlDollars <= 0);

    // Intraday equity curve for max drawdown
    let equity = 0;
    let peak = 0;
    let maxDD = 0;
    for (const t of trades) {
      equity += t.pnlDollars;
      if (equity > peak) peak = equity;
      if (peak - equity > maxDD) maxDD = peak - equity;
    }

    results.push({
      date: day.date,
      regime: day.gexRegime,
      trades,
      totalPnlPoints: trades.reduce((s, t) => s + t.pnlPoints, 0),
      totalPnlDollars: Math.round(dailyPnl * 100) / 100,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: trades.length > 0 ? Math.round((wins.length / trades.length) * 1000) / 10 : 0,
      maxDrawdownIntraday: Math.round(maxDD * 100) / 100,
      hitDailyLimit: hitLimit,
    });
  }

  return results;
}

export type { ScalpTrade, DayResult, StrategyParams };
