/**
 * Strategy implementations for backtesting.
 *
 * Strategy 1: VWAP Mean Reversion
 *   - When price deviates > X standard deviations from VWAP, fade the move
 *   - Only during first 2 hours of RTH (highest edge window)
 *   - Trend filter: skip if price has been trending away from VWAP for 15+ bars
 *
 * Strategy 2: Opening Range Breakout (ORB)
 *   - Define the range of first 15 minutes
 *   - Go long on break above, short on break below
 *   - Stop at opposite end of range
 *   - Target: 1.5x range width
 *
 * Strategy 3: Combined (VWAP reversion + ORB + trend filter)
 */

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
}

interface Trade {
  entryBar: number;
  exitBar: number;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  pnlPoints: number;
  pnlDollars: number;  // For MES: $5/point. For MNQ: $2/point
  reason: string;
  stopPrice: number;
  targetPrice: number;
}

interface StrategyResult {
  name: string;
  trades: Trade[];
  totalPnlPoints: number;
  totalPnlDollars: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdownPoints: number;
  maxDrawdownDollars: number;
  sharpeRatio: number;
  totalTradingDays: number;
  tradesPerDay: number;
}

// ============================================================
// Strategy 1: VWAP Mean Reversion
// ============================================================
export function vwapMeanReversion(
  days: { bars: Bar[]; regime: string }[],
  params: {
    deviationThreshold: number;   // How many points from VWAP to trigger (e.g., 30)
    stopPoints: number;           // Stop loss in points (e.g., 20)
    targetPoints: number;         // Take profit in points (e.g., 15)
    maxBarsHeld: number;          // Max bars before forced exit (e.g., 30)
    onlyFirst2Hours: boolean;     // Only trade 9:30-11:30
    pointValue: number;           // $ per point (MES=5, MNQ=2)
    trendFilterBars: number;      // Skip if trending for this many bars
  }
): StrategyResult {
  const trades: Trade[] = [];

  for (const day of days) {
    const { bars } = day;
    if (bars.length < 60) continue;

    // Calculate rolling std deviation of price-vwap over first 30 bars
    // to calibrate deviation threshold dynamically
    let inPosition = false;
    let entryBar = 0;
    let entryPrice = 0;
    let direction: 'long' | 'short' = 'long';
    let stopPrice = 0;
    let targetPrice = 0;

    // Collect price-vwap deviations for std calculation
    const deviations: number[] = [];

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const minuteOfDay = i;

      // Only trade first 2 hours if flag set
      if (params.onlyFirst2Hours && minuteOfDay >= 120) {
        // Force exit any open position at bar 120
        if (inPosition) {
          const pnl = direction === 'long'
            ? bar.close - entryPrice
            : entryPrice - bar.close;
          trades.push({
            entryBar, exitBar: i, direction, entryPrice,
            exitPrice: bar.close,
            pnlPoints: pnl,
            pnlDollars: pnl * params.pointValue,
            reason: 'time_exit',
            stopPrice, targetPrice
          });
          inPosition = false;
        }
        continue;
      }

      // Skip first 5 bars (let VWAP establish)
      if (minuteOfDay < 5) continue;

      const deviation = bar.close - bar.vwap;
      deviations.push(deviation);

      // Manage open position
      if (inPosition) {
        const barsHeld = i - entryBar;

        // Check stop loss
        if (direction === 'long' && bar.low <= stopPrice) {
          trades.push({
            entryBar, exitBar: i, direction, entryPrice,
            exitPrice: stopPrice,
            pnlPoints: stopPrice - entryPrice,
            pnlDollars: (stopPrice - entryPrice) * params.pointValue,
            reason: 'stop_loss',
            stopPrice, targetPrice
          });
          inPosition = false;
          continue;
        }
        if (direction === 'short' && bar.high >= stopPrice) {
          trades.push({
            entryBar, exitBar: i, direction, entryPrice,
            exitPrice: stopPrice,
            pnlPoints: entryPrice - stopPrice,
            pnlDollars: (entryPrice - stopPrice) * params.pointValue,
            reason: 'stop_loss',
            stopPrice, targetPrice
          });
          inPosition = false;
          continue;
        }

        // Check take profit
        if (direction === 'long' && bar.high >= targetPrice) {
          trades.push({
            entryBar, exitBar: i, direction, entryPrice,
            exitPrice: targetPrice,
            pnlPoints: targetPrice - entryPrice,
            pnlDollars: (targetPrice - entryPrice) * params.pointValue,
            reason: 'take_profit',
            stopPrice, targetPrice
          });
          inPosition = false;
          continue;
        }
        if (direction === 'short' && bar.low <= targetPrice) {
          trades.push({
            entryBar, exitBar: i, direction, entryPrice,
            exitPrice: targetPrice,
            pnlPoints: entryPrice - targetPrice,
            pnlDollars: (entryPrice - targetPrice) * params.pointValue,
            reason: 'take_profit',
            stopPrice, targetPrice
          });
          inPosition = false;
          continue;
        }

        // Max hold time
        if (barsHeld >= params.maxBarsHeld) {
          const pnl = direction === 'long'
            ? bar.close - entryPrice
            : entryPrice - bar.close;
          trades.push({
            entryBar, exitBar: i, direction, entryPrice,
            exitPrice: bar.close,
            pnlPoints: pnl,
            pnlDollars: pnl * params.pointValue,
            reason: 'max_hold',
            stopPrice, targetPrice
          });
          inPosition = false;
          continue;
        }

        continue; // Still in position, no entry signals
      }

      // --- Entry Logic ---
      // Trend filter: check if price has been consistently on one side of VWAP
      if (params.trendFilterBars > 0 && deviations.length >= params.trendFilterBars) {
        const recent = deviations.slice(-params.trendFilterBars);
        const allPositive = recent.every(d => d > 0);
        const allNegative = recent.every(d => d < 0);
        if (allPositive || allNegative) continue; // Trending, skip
      }

      // Check for VWAP deviation entry
      if (deviation > params.deviationThreshold) {
        // Price above VWAP: SHORT (fade the move)
        direction = 'short';
        entryPrice = bar.close;
        entryBar = i;
        stopPrice = entryPrice + params.stopPoints;
        targetPrice = entryPrice - params.targetPoints;
        inPosition = true;
      } else if (deviation < -params.deviationThreshold) {
        // Price below VWAP: LONG (fade the move)
        direction = 'long';
        entryPrice = bar.close;
        entryBar = i;
        stopPrice = entryPrice - params.stopPoints;
        targetPrice = entryPrice + params.targetPoints;
        inPosition = true;
      }
    }

    // Force close at end of day
    if (inPosition) {
      const lastBar = bars[bars.length - 1];
      const pnl = direction === 'long'
        ? lastBar.close - entryPrice
        : entryPrice - lastBar.close;
      trades.push({
        entryBar, exitBar: bars.length - 1, direction, entryPrice,
        exitPrice: lastBar.close,
        pnlPoints: pnl,
        pnlDollars: pnl * params.pointValue,
        reason: 'eod_close',
        stopPrice, targetPrice
      });
    }
  }

  return calculateResults('VWAP Mean Reversion', trades, days.length);
}

// ============================================================
// Strategy 2: Opening Range Breakout
// ============================================================
export function openingRangeBreakout(
  days: { bars: Bar[]; regime: string }[],
  params: {
    orbMinutes: number;           // Minutes for opening range (5, 15, or 30)
    targetMultiplier: number;     // Target as multiple of range (1.5, 2.0)
    stopAtOppositeEnd: boolean;   // Stop at other end of range
    maxBarsHeld: number;          // Max hold time
    pointValue: number;
    minRangePoints: number;       // Min range size to trade (avoid tiny ranges)
    maxRangePoints: number;       // Max range size (avoid huge ranges = news day)
  }
): StrategyResult {
  const trades: Trade[] = [];

  for (const day of days) {
    const { bars } = day;
    if (bars.length < params.orbMinutes + 60) continue;

    // Calculate opening range
    const orbBars = bars.slice(0, params.orbMinutes);
    const orbHigh = Math.max(...orbBars.map(b => b.high));
    const orbLow = Math.min(...orbBars.map(b => b.low));
    const orbRange = orbHigh - orbLow;

    // Filter by range size
    if (orbRange < params.minRangePoints) continue;
    if (orbRange > params.maxRangePoints) continue;

    let inPosition = false;
    let entryBar = 0;
    let entryPrice = 0;
    let direction: 'long' | 'short' = 'long';
    let stopPrice = 0;
    let targetPrice = 0;
    let traded = false; // Only one trade per day for ORB

    for (let i = params.orbMinutes; i < Math.min(bars.length, 240); i++) {
      const bar = bars[i];

      if (inPosition) {
        const barsHeld = i - entryBar;

        // Stop loss
        if (direction === 'long' && bar.low <= stopPrice) {
          trades.push({
            entryBar, exitBar: i, direction, entryPrice,
            exitPrice: stopPrice,
            pnlPoints: stopPrice - entryPrice,
            pnlDollars: (stopPrice - entryPrice) * params.pointValue,
            reason: 'stop_loss',
            stopPrice, targetPrice
          });
          inPosition = false;
          traded = true;
          continue;
        }
        if (direction === 'short' && bar.high >= stopPrice) {
          trades.push({
            entryBar, exitBar: i, direction, entryPrice,
            exitPrice: stopPrice,
            pnlPoints: entryPrice - stopPrice,
            pnlDollars: (entryPrice - stopPrice) * params.pointValue,
            reason: 'stop_loss',
            stopPrice, targetPrice
          });
          inPosition = false;
          traded = true;
          continue;
        }

        // Take profit
        if (direction === 'long' && bar.high >= targetPrice) {
          trades.push({
            entryBar, exitBar: i, direction, entryPrice,
            exitPrice: targetPrice,
            pnlPoints: targetPrice - entryPrice,
            pnlDollars: (targetPrice - entryPrice) * params.pointValue,
            reason: 'take_profit',
            stopPrice, targetPrice
          });
          inPosition = false;
          traded = true;
          continue;
        }
        if (direction === 'short' && bar.low <= targetPrice) {
          trades.push({
            entryBar, exitBar: i, direction, entryPrice,
            exitPrice: targetPrice,
            pnlPoints: entryPrice - targetPrice,
            pnlDollars: (entryPrice - targetPrice) * params.pointValue,
            reason: 'take_profit',
            stopPrice, targetPrice
          });
          inPosition = false;
          traded = true;
          continue;
        }

        // Max hold
        if (barsHeld >= params.maxBarsHeld) {
          const pnl = direction === 'long'
            ? bar.close - entryPrice
            : entryPrice - bar.close;
          trades.push({
            entryBar, exitBar: i, direction, entryPrice,
            exitPrice: bar.close,
            pnlPoints: pnl,
            pnlDollars: pnl * params.pointValue,
            reason: 'max_hold',
            stopPrice, targetPrice
          });
          inPosition = false;
          traded = true;
          continue;
        }
        continue;
      }

      if (traded) break; // One trade per day

      // Entry: breakout above ORB high
      if (bar.high > orbHigh) {
        direction = 'long';
        entryPrice = orbHigh; // Assume fill at breakout level
        entryBar = i;
        stopPrice = params.stopAtOppositeEnd ? orbLow : orbHigh - orbRange * 0.5;
        targetPrice = orbHigh + orbRange * params.targetMultiplier;
        inPosition = true;
      }
      // Entry: breakout below ORB low
      else if (bar.low < orbLow) {
        direction = 'short';
        entryPrice = orbLow;
        entryBar = i;
        stopPrice = params.stopAtOppositeEnd ? orbHigh : orbLow + orbRange * 0.5;
        targetPrice = orbLow - orbRange * params.targetMultiplier;
        inPosition = true;
      }
    }

    // Force close
    if (inPosition) {
      const lastBar = bars[Math.min(bars.length - 1, 239)];
      const pnl = direction === 'long'
        ? lastBar.close - entryPrice
        : entryPrice - lastBar.close;
      trades.push({
        entryBar, exitBar: bars.length - 1, direction, entryPrice,
        exitPrice: lastBar.close,
        pnlPoints: pnl,
        pnlDollars: pnl * params.pointValue,
        reason: 'eod_close',
        stopPrice, targetPrice
      });
    }
  }

  return calculateResults('Opening Range Breakout', trades, days.length);
}

// ============================================================
// Strategy 3: Random baseline (for comparison)
// ============================================================
export function randomBaseline(
  days: { bars: Bar[]; regime: string }[],
  params: {
    stopPoints: number;
    targetPoints: number;
    maxBarsHeld: number;
    pointValue: number;
    tradesPerDay: number;
  }
): StrategyResult {
  const trades: Trade[] = [];

  for (const day of days) {
    const { bars } = day;
    if (bars.length < 120) continue;

    for (let t = 0; t < params.tradesPerDay; t++) {
      // Random entry time in first 2 hours
      const entryIdx = 5 + Math.floor(Math.random() * 110);
      const direction: 'long' | 'short' = Math.random() > 0.5 ? 'long' : 'short';
      const entryPrice = bars[entryIdx].close;
      const stopPrice = direction === 'long'
        ? entryPrice - params.stopPoints
        : entryPrice + params.stopPoints;
      const targetPrice = direction === 'long'
        ? entryPrice + params.targetPoints
        : entryPrice - params.targetPoints;

      for (let i = entryIdx + 1; i < Math.min(bars.length, entryIdx + params.maxBarsHeld); i++) {
        const bar = bars[i];

        if (direction === 'long' && bar.low <= stopPrice) {
          trades.push({
            entryBar: entryIdx, exitBar: i, direction, entryPrice,
            exitPrice: stopPrice, pnlPoints: stopPrice - entryPrice,
            pnlDollars: (stopPrice - entryPrice) * params.pointValue,
            reason: 'stop_loss', stopPrice, targetPrice
          });
          break;
        }
        if (direction === 'short' && bar.high >= stopPrice) {
          trades.push({
            entryBar: entryIdx, exitBar: i, direction, entryPrice,
            exitPrice: stopPrice, pnlPoints: entryPrice - stopPrice,
            pnlDollars: (entryPrice - stopPrice) * params.pointValue,
            reason: 'stop_loss', stopPrice, targetPrice
          });
          break;
        }
        if (direction === 'long' && bar.high >= targetPrice) {
          trades.push({
            entryBar: entryIdx, exitBar: i, direction, entryPrice,
            exitPrice: targetPrice, pnlPoints: targetPrice - entryPrice,
            pnlDollars: (targetPrice - entryPrice) * params.pointValue,
            reason: 'take_profit', stopPrice, targetPrice
          });
          break;
        }
        if (direction === 'short' && bar.low <= targetPrice) {
          trades.push({
            entryBar: entryIdx, exitBar: i, direction, entryPrice,
            exitPrice: targetPrice, pnlPoints: entryPrice - targetPrice,
            pnlDollars: (entryPrice - targetPrice) * params.pointValue,
            reason: 'take_profit', stopPrice, targetPrice
          });
          break;
        }

        // Last bar in hold window
        if (i === Math.min(bars.length - 1, entryIdx + params.maxBarsHeld - 1)) {
          const pnl = direction === 'long'
            ? bar.close - entryPrice
            : entryPrice - bar.close;
          trades.push({
            entryBar: entryIdx, exitBar: i, direction, entryPrice,
            exitPrice: bar.close, pnlPoints: pnl,
            pnlDollars: pnl * params.pointValue,
            reason: 'max_hold', stopPrice, targetPrice
          });
        }
      }
    }
  }

  return calculateResults('Random Baseline', trades, days.length);
}


// ============================================================
// Results Calculator
// ============================================================
function calculateResults(name: string, trades: Trade[], totalDays: number): StrategyResult {
  if (trades.length === 0) {
    return {
      name, trades, totalPnlPoints: 0, totalPnlDollars: 0,
      winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0,
      maxDrawdownPoints: 0, maxDrawdownDollars: 0, sharpeRatio: 0,
      totalTradingDays: totalDays, tradesPerDay: 0
    };
  }

  const wins = trades.filter(t => t.pnlPoints > 0);
  const losses = trades.filter(t => t.pnlPoints <= 0);

  const totalPnlPoints = trades.reduce((s, t) => s + t.pnlPoints, 0);
  const totalPnlDollars = trades.reduce((s, t) => s + t.pnlDollars, 0);

  const grossWins = wins.reduce((s, t) => s + t.pnlDollars, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnlDollars, 0));

  // Max drawdown
  let peak = 0;
  let maxDD = 0;
  let equity = 0;
  for (const trade of trades) {
    equity += trade.pnlDollars;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe ratio (annualized, using daily returns)
  const dailyReturns: number[] = [];
  let dayPnl = 0;
  let currentDay = -1;
  for (const trade of trades) {
    if (trade.entryBar === 0 && dayPnl !== 0) {
      dailyReturns.push(dayPnl);
      dayPnl = 0;
    }
    dayPnl += trade.pnlDollars;
  }
  if (dayPnl !== 0) dailyReturns.push(dayPnl);

  const avgDaily = dailyReturns.length > 0
    ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length : 0;
  const stdDaily = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgDaily) ** 2, 0) / (dailyReturns.length - 1)) : 1;
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

  return {
    name,
    trades,
    totalPnlPoints,
    totalPnlDollars: Math.round(totalPnlDollars * 100) / 100,
    winRate: wins.length / trades.length,
    avgWin: wins.length > 0 ? grossWins / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLosses / losses.length : 0,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : Infinity,
    maxDrawdownPoints: maxDD / (trades[0]?.pnlDollars !== 0 ? Math.abs(trades[0].pnlDollars / trades[0].pnlPoints) : 5),
    maxDrawdownDollars: Math.round(maxDD * 100) / 100,
    sharpeRatio: Math.round(sharpe * 100) / 100,
    totalTradingDays: totalDays,
    tradesPerDay: Math.round((trades.length / totalDays) * 100) / 100
  };
}
