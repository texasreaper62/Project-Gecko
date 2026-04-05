/**
 * Main backtest runner.
 *
 * Generates synthetic NQ data, runs all strategies with multiple parameter
 * combinations, compares against random baseline, and runs Monte Carlo
 * simulation to test statistical significance.
 */

// Inline the data generator and strategies to avoid import issues with ts-node
// ============================================================
// DATA GENERATOR (from generate-data.ts)
// ============================================================

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
}

interface DayData {
  date: string;
  regime: 'mean_revert' | 'trend_up' | 'trend_down' | 'chop';
  bars: Bar[];
  dailyRange: number;
  openPrice: number;
  closePrice: number;
}

interface Trade {
  entryBar: number;
  exitBar: number;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  pnlPoints: number;
  pnlDollars: number;
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

function gaussianRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function generateDay(date: string, openPrice: number): DayData {
  const roll = Math.random();
  let regime: DayData['regime'];
  if (roll < 0.60) regime = 'mean_revert';
  else if (roll < 0.75) regime = 'trend_up';
  else if (roll < 0.90) regime = 'trend_down';
  else regime = 'chop';

  const baseVol = 0.008;
  const volMultiplier = regime === 'chop' ? 0.5 :
                        regime === 'mean_revert' ? 0.7 : 1.3;
  const dailyVol = baseVol * volMultiplier * (0.7 + Math.random() * 0.6);
  const minuteVol = dailyVol / Math.sqrt(390);

  const bars: Bar[] = [];
  let price = openPrice;
  let cumVolPrice = 0;
  let cumVol = 0;

  const trendDrift = regime === 'trend_up' ? dailyVol / 390 * 0.15 :
                     regime === 'trend_down' ? -dailyVol / 390 * 0.15 : 0;

  for (let i = 0; i < 390; i++) {
    let volScale = 1.0;
    if (i < 30) volScale = 2.0 - (i / 30);
    else if (i > 360) volScale = 1.0 + (i - 360) / 30;
    else volScale = 0.8 + Math.random() * 0.4;

    const noise = gaussianRandom() * minuteVol * price * volScale;

    let meanRevForce = 0;
    if (regime === 'mean_revert' && cumVol > 0) {
      const currentVwap = cumVolPrice / cumVol;
      const deviation = (price - currentVwap) / currentVwap;
      meanRevForce = -deviation * price * 0.02;
    }

    const drift = trendDrift * price;
    const chopExtra = regime === 'chop' ? gaussianRandom() * minuteVol * price * 0.3 : 0;

    const newPrice = price + noise + meanRevForce + drift + chopExtra;

    const barOpen = price;
    const barClose = newPrice;
    const barHigh = Math.max(barOpen, barClose) + Math.abs(gaussianRandom() * minuteVol * price * 0.3);
    const barLow = Math.min(barOpen, barClose) - Math.abs(gaussianRandom() * minuteVol * price * 0.3);

    let baseVolume = 5000 + Math.random() * 3000;
    if (i < 30) baseVolume *= 3;
    else if (i > 360) baseVolume *= 2.5;
    else if (i > 180 && i < 240) baseVolume *= 0.5;

    const volume = Math.round(baseVolume);
    const typicalPrice = (barHigh + barLow + barClose) / 3;
    cumVolPrice += typicalPrice * volume;
    cumVol += volume;

    const [year, month, day] = date.split('-').map(Number);
    const baseMs = new Date(year, month - 1, day, 9, 30, 0).getTime();

    bars.push({
      timestamp: baseMs + i * 60000,
      open: Math.round(barOpen * 100) / 100,
      high: Math.round(barHigh * 100) / 100,
      low: Math.round(barLow * 100) / 100,
      close: Math.round(barClose * 100) / 100,
      volume,
      vwap: Math.round((cumVolPrice / cumVol) * 100) / 100
    });

    price = newPrice;
  }

  const dailyHigh = Math.max(...bars.map(b => b.high));
  const dailyLow = Math.min(...bars.map(b => b.low));

  return {
    date, regime, bars,
    dailyRange: dailyHigh - dailyLow,
    openPrice,
    closePrice: bars[bars.length - 1].close
  };
}

function generateDataset(numDays: number, seed?: number): DayData[] {
  const days: DayData[] = [];
  let price = 20000;
  const startDate = new Date(2026, 0, 5);
  let currentDate = startDate;

  for (let d = 0; d < numDays; d++) {
    while (currentDate.getDay() === 0 || currentDate.getDay() === 6) {
      currentDate = new Date(currentDate.getTime() + 86400000);
    }
    const dateStr = currentDate.toISOString().split('T')[0];
    price += gaussianRandom() * 0.003 * price;
    const day = generateDay(dateStr, price);
    days.push(day);
    price = day.closePrice;
    currentDate = new Date(currentDate.getTime() + 86400000);
  }
  return days;
}

// ============================================================
// STRATEGIES
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

  let peak = 0, maxDD = 0, equity = 0;
  for (const trade of trades) {
    equity += trade.pnlDollars;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  const dailyReturns: Map<number, number> = new Map();
  for (const trade of trades) {
    const dayKey = trade.entryBar; // rough proxy
    const existing = dailyReturns.get(dayKey) || 0;
    dailyReturns.set(dayKey, existing + trade.pnlDollars);
  }
  const returns = Array.from(dailyReturns.values());
  const avgDaily = returns.reduce((s, r) => s + r, 0) / returns.length;
  const stdDaily = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avgDaily) ** 2, 0) / (returns.length - 1)) : 1;
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

  const pv = trades.length > 0 && trades[0].pnlPoints !== 0
    ? Math.abs(trades[0].pnlDollars / trades[0].pnlPoints) : 5;

  return {
    name, trades, totalPnlPoints: Math.round(totalPnlPoints * 100) / 100,
    totalPnlDollars: Math.round(totalPnlDollars * 100) / 100,
    winRate: Math.round((wins.length / trades.length) * 1000) / 10,
    avgWin: Math.round((wins.length > 0 ? grossWins / wins.length : 0) * 100) / 100,
    avgLoss: Math.round((losses.length > 0 ? grossLosses / losses.length : 0) * 100) / 100,
    profitFactor: Math.round((grossLosses > 0 ? grossWins / grossLosses : 99) * 100) / 100,
    maxDrawdownPoints: Math.round((maxDD / pv) * 100) / 100,
    maxDrawdownDollars: Math.round(maxDD * 100) / 100,
    sharpeRatio: Math.round(sharpe * 100) / 100,
    totalTradingDays: totalDays,
    tradesPerDay: Math.round((trades.length / totalDays) * 100) / 100
  };
}

function runVwapMeanReversion(
  days: DayData[],
  deviationThreshold: number,
  stopPoints: number,
  targetPoints: number,
  maxBarsHeld: number,
  onlyFirst2Hours: boolean,
  pointValue: number,
  trendFilterBars: number
): StrategyResult {
  const trades: Trade[] = [];

  for (const day of days) {
    const { bars } = day;
    if (bars.length < 60) continue;

    let inPosition = false;
    let entryBar = 0, entryPrice = 0, stopPrice = 0, targetPrice = 0;
    let direction: 'long' | 'short' = 'long';
    const deviations: number[] = [];

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (onlyFirst2Hours && i >= 120) {
        if (inPosition) {
          const pnl = direction === 'long' ? bar.close - entryPrice : entryPrice - bar.close;
          trades.push({ entryBar, exitBar: i, direction, entryPrice, exitPrice: bar.close,
            pnlPoints: pnl, pnlDollars: pnl * pointValue, reason: 'time_exit', stopPrice, targetPrice });
          inPosition = false;
        }
        continue;
      }

      if (i < 5) continue;

      const deviation = bar.close - bar.vwap;
      deviations.push(deviation);

      if (inPosition) {
        const barsHeld = i - entryBar;
        // Stop
        if (direction === 'long' && bar.low <= stopPrice) {
          trades.push({ entryBar, exitBar: i, direction, entryPrice, exitPrice: stopPrice,
            pnlPoints: stopPrice - entryPrice, pnlDollars: (stopPrice - entryPrice) * pointValue,
            reason: 'stop_loss', stopPrice, targetPrice });
          inPosition = false; continue;
        }
        if (direction === 'short' && bar.high >= stopPrice) {
          trades.push({ entryBar, exitBar: i, direction, entryPrice, exitPrice: stopPrice,
            pnlPoints: entryPrice - stopPrice, pnlDollars: (entryPrice - stopPrice) * pointValue,
            reason: 'stop_loss', stopPrice, targetPrice });
          inPosition = false; continue;
        }
        // Target
        if (direction === 'long' && bar.high >= targetPrice) {
          trades.push({ entryBar, exitBar: i, direction, entryPrice, exitPrice: targetPrice,
            pnlPoints: targetPrice - entryPrice, pnlDollars: (targetPrice - entryPrice) * pointValue,
            reason: 'take_profit', stopPrice, targetPrice });
          inPosition = false; continue;
        }
        if (direction === 'short' && bar.low <= targetPrice) {
          trades.push({ entryBar, exitBar: i, direction, entryPrice, exitPrice: targetPrice,
            pnlPoints: entryPrice - targetPrice, pnlDollars: (entryPrice - targetPrice) * pointValue,
            reason: 'take_profit', stopPrice, targetPrice });
          inPosition = false; continue;
        }
        // Max hold
        if (barsHeld >= maxBarsHeld) {
          const pnl = direction === 'long' ? bar.close - entryPrice : entryPrice - bar.close;
          trades.push({ entryBar, exitBar: i, direction, entryPrice, exitPrice: bar.close,
            pnlPoints: pnl, pnlDollars: pnl * pointValue, reason: 'max_hold', stopPrice, targetPrice });
          inPosition = false; continue;
        }
        continue;
      }

      // Trend filter
      if (trendFilterBars > 0 && deviations.length >= trendFilterBars) {
        const recent = deviations.slice(-trendFilterBars);
        if (recent.every(d => d > 0) || recent.every(d => d < 0)) continue;
      }

      // Entry
      if (deviation > deviationThreshold) {
        direction = 'short'; entryPrice = bar.close; entryBar = i;
        stopPrice = entryPrice + stopPoints; targetPrice = entryPrice - targetPoints;
        inPosition = true;
      } else if (deviation < -deviationThreshold) {
        direction = 'long'; entryPrice = bar.close; entryBar = i;
        stopPrice = entryPrice - stopPoints; targetPrice = entryPrice + targetPoints;
        inPosition = true;
      }
    }

    if (inPosition) {
      const lastBar = bars[bars.length - 1];
      const pnl = direction === 'long' ? lastBar.close - entryPrice : entryPrice - lastBar.close;
      trades.push({ entryBar, exitBar: bars.length - 1, direction, entryPrice, exitPrice: lastBar.close,
        pnlPoints: pnl, pnlDollars: pnl * pointValue, reason: 'eod_close', stopPrice, targetPrice });
    }
  }

  return calculateResults('VWAP Mean Reversion', trades, days.length);
}

function runORB(
  days: DayData[],
  orbMinutes: number,
  targetMultiplier: number,
  maxBarsHeld: number,
  pointValue: number,
  minRange: number,
  maxRange: number
): StrategyResult {
  const trades: Trade[] = [];

  for (const day of days) {
    const { bars } = day;
    if (bars.length < orbMinutes + 60) continue;

    const orbBars = bars.slice(0, orbMinutes);
    const orbHigh = Math.max(...orbBars.map(b => b.high));
    const orbLow = Math.min(...orbBars.map(b => b.low));
    const orbRange = orbHigh - orbLow;

    if (orbRange < minRange || orbRange > maxRange) continue;

    let inPosition = false;
    let entryBar = 0, entryPrice = 0, stopPrice = 0, targetPrice = 0;
    let direction: 'long' | 'short' = 'long';
    let traded = false;

    for (let i = orbMinutes; i < Math.min(bars.length, 240); i++) {
      const bar = bars[i];

      if (inPosition) {
        const barsHeld = i - entryBar;
        if (direction === 'long' && bar.low <= stopPrice) {
          trades.push({ entryBar, exitBar: i, direction, entryPrice, exitPrice: stopPrice,
            pnlPoints: stopPrice - entryPrice, pnlDollars: (stopPrice - entryPrice) * pointValue,
            reason: 'stop_loss', stopPrice, targetPrice });
          inPosition = false; traded = true; continue;
        }
        if (direction === 'short' && bar.high >= stopPrice) {
          trades.push({ entryBar, exitBar: i, direction, entryPrice, exitPrice: stopPrice,
            pnlPoints: entryPrice - stopPrice, pnlDollars: (entryPrice - stopPrice) * pointValue,
            reason: 'stop_loss', stopPrice, targetPrice });
          inPosition = false; traded = true; continue;
        }
        if (direction === 'long' && bar.high >= targetPrice) {
          trades.push({ entryBar, exitBar: i, direction, entryPrice, exitPrice: targetPrice,
            pnlPoints: targetPrice - entryPrice, pnlDollars: (targetPrice - entryPrice) * pointValue,
            reason: 'take_profit', stopPrice, targetPrice });
          inPosition = false; traded = true; continue;
        }
        if (direction === 'short' && bar.low <= targetPrice) {
          trades.push({ entryBar, exitBar: i, direction, entryPrice, exitPrice: targetPrice,
            pnlPoints: entryPrice - targetPrice, pnlDollars: (entryPrice - targetPrice) * pointValue,
            reason: 'take_profit', stopPrice, targetPrice });
          inPosition = false; traded = true; continue;
        }
        if (barsHeld >= maxBarsHeld) {
          const pnl = direction === 'long' ? bar.close - entryPrice : entryPrice - bar.close;
          trades.push({ entryBar, exitBar: i, direction, entryPrice, exitPrice: bar.close,
            pnlPoints: pnl, pnlDollars: pnl * pointValue, reason: 'max_hold', stopPrice, targetPrice });
          inPosition = false; traded = true; continue;
        }
        continue;
      }

      if (traded) break;

      if (bar.high > orbHigh) {
        direction = 'long'; entryPrice = orbHigh; entryBar = i;
        stopPrice = orbLow; targetPrice = orbHigh + orbRange * targetMultiplier;
        inPosition = true;
      } else if (bar.low < orbLow) {
        direction = 'short'; entryPrice = orbLow; entryBar = i;
        stopPrice = orbHigh; targetPrice = orbLow - orbRange * targetMultiplier;
        inPosition = true;
      }
    }

    if (inPosition) {
      const idx = Math.min(bars.length - 1, 239);
      const pnl = direction === 'long' ? bars[idx].close - entryPrice : entryPrice - bars[idx].close;
      trades.push({ entryBar, exitBar: idx, direction, entryPrice, exitPrice: bars[idx].close,
        pnlPoints: pnl, pnlDollars: pnl * pointValue, reason: 'eod_close', stopPrice, targetPrice });
    }
  }

  return calculateResults('Opening Range Breakout', trades, days.length);
}

function runRandom(days: DayData[], stopPoints: number, targetPoints: number,
  maxBarsHeld: number, pointValue: number, tradesPerDay: number): StrategyResult {
  const trades: Trade[] = [];
  for (const day of days) {
    const { bars } = day;
    if (bars.length < 120) continue;
    for (let t = 0; t < tradesPerDay; t++) {
      const entryIdx = 5 + Math.floor(Math.random() * 110);
      const direction: 'long' | 'short' = Math.random() > 0.5 ? 'long' : 'short';
      const ep = bars[entryIdx].close;
      const sp = direction === 'long' ? ep - stopPoints : ep + stopPoints;
      const tp = direction === 'long' ? ep + targetPoints : ep - targetPoints;

      for (let i = entryIdx + 1; i < Math.min(bars.length, entryIdx + maxBarsHeld); i++) {
        const bar = bars[i];
        if (direction === 'long' && bar.low <= sp) {
          trades.push({ entryBar: entryIdx, exitBar: i, direction, entryPrice: ep, exitPrice: sp,
            pnlPoints: sp - ep, pnlDollars: (sp - ep) * pointValue, reason: 'stop_loss', stopPrice: sp, targetPrice: tp });
          break;
        }
        if (direction === 'short' && bar.high >= sp) {
          trades.push({ entryBar: entryIdx, exitBar: i, direction, entryPrice: ep, exitPrice: sp,
            pnlPoints: ep - sp, pnlDollars: (ep - sp) * pointValue, reason: 'stop_loss', stopPrice: sp, targetPrice: tp });
          break;
        }
        if (direction === 'long' && bar.high >= tp) {
          trades.push({ entryBar: entryIdx, exitBar: i, direction, entryPrice: ep, exitPrice: tp,
            pnlPoints: tp - ep, pnlDollars: (tp - ep) * pointValue, reason: 'take_profit', stopPrice: sp, targetPrice: tp });
          break;
        }
        if (direction === 'short' && bar.low <= tp) {
          trades.push({ entryBar: entryIdx, exitBar: i, direction, entryPrice: ep, exitPrice: tp,
            pnlPoints: ep - tp, pnlDollars: (ep - tp) * pointValue, reason: 'take_profit', stopPrice: sp, targetPrice: tp });
          break;
        }
        if (i === Math.min(bars.length - 1, entryIdx + maxBarsHeld - 1)) {
          const pnl = direction === 'long' ? bar.close - ep : ep - bar.close;
          trades.push({ entryBar: entryIdx, exitBar: i, direction, entryPrice: ep, exitPrice: bar.close,
            pnlPoints: pnl, pnlDollars: pnl * pointValue, reason: 'max_hold', stopPrice: sp, targetPrice: tp });
        }
      }
    }
  }
  return calculateResults('Random Baseline', trades, days.length);
}

// ============================================================
// MAIN RUNNER
// ============================================================

function printResult(r: StrategyResult): void {
  const edgeIndicator = r.profitFactor > 1.3 ? ' *** EDGE ***' :
                        r.profitFactor > 1.1 ? ' * marginal *' : '';
  console.log(`\n--- ${r.name}${edgeIndicator} ---`);
  console.log(`  Trades: ${r.trades.length} (${r.tradesPerDay}/day)`);
  console.log(`  Win Rate: ${r.winRate}%`);
  console.log(`  Avg Win: $${r.avgWin.toFixed(2)}  |  Avg Loss: $${r.avgLoss.toFixed(2)}`);
  console.log(`  Profit Factor: ${r.profitFactor}`);
  console.log(`  Total P&L: $${r.totalPnlDollars.toFixed(2)} (${r.totalPnlPoints.toFixed(1)} pts)`);
  console.log(`  Max Drawdown: $${r.maxDrawdownDollars.toFixed(2)}`);
  console.log(`  Sharpe Ratio: ${r.sharpeRatio}`);
  console.log(`  Exit Reasons: ${summarizeExits(r.trades)}`);
}

function summarizeExits(trades: Trade[]): string {
  const counts: Record<string, number> = {};
  for (const t of trades) {
    counts[t.reason] = (counts[t.reason] || 0) + 1;
  }
  return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ');
}

console.log('============================================');
console.log('  NQ FUTURES STRATEGY BACKTEST');
console.log('  120 trading days, MES ($5/point)');
console.log('============================================');

// Run 5 independent simulations for statistical robustness
const NUM_SIMS = 5;
const DAYS_PER_SIM = 120;
const POINT_VALUE = 5; // MES

const allResults: {
  vwap_conservative: StrategyResult[];
  vwap_aggressive: StrategyResult[];
  vwap_wide: StrategyResult[];
  orb_15m: StrategyResult[];
  orb_5m: StrategyResult[];
  orb_30m: StrategyResult[];
  random: StrategyResult[];
} = {
  vwap_conservative: [],
  vwap_aggressive: [],
  vwap_wide: [],
  orb_15m: [],
  orb_5m: [],
  orb_30m: [],
  random: []
};

for (let sim = 0; sim < NUM_SIMS; sim++) {
  console.log(`\n\n========== SIMULATION ${sim + 1}/${NUM_SIMS} ==========`);
  const days = generateDataset(DAYS_PER_SIM);

  const regimes = { mean_revert: 0, trend_up: 0, trend_down: 0, chop: 0 };
  for (const d of days) regimes[d.regime]++;
  console.log(`Regimes: MR=${regimes.mean_revert} TU=${regimes.trend_up} TD=${regimes.trend_down} CH=${regimes.chop}`);

  // VWAP Mean Reversion -- Conservative (tight stops, moderate target)
  const vwapCons = runVwapMeanReversion(days, 30, 20, 15, 30, true, POINT_VALUE, 10);
  vwapCons.name = 'VWAP MR Conservative (dev=30, stop=20, tgt=15)';
  allResults.vwap_conservative.push(vwapCons);
  printResult(vwapCons);

  // VWAP Mean Reversion -- Aggressive (wider deviation, bigger target)
  const vwapAgg = runVwapMeanReversion(days, 50, 30, 25, 45, true, POINT_VALUE, 15);
  vwapAgg.name = 'VWAP MR Aggressive (dev=50, stop=30, tgt=25)';
  allResults.vwap_aggressive.push(vwapAgg);
  printResult(vwapAgg);

  // VWAP Mean Reversion -- Wide (large deviation, full day)
  const vwapWide = runVwapMeanReversion(days, 80, 40, 35, 60, false, POINT_VALUE, 20);
  vwapWide.name = 'VWAP MR Wide (dev=80, stop=40, tgt=35, all-day)';
  allResults.vwap_wide.push(vwapWide);
  printResult(vwapWide);

  // ORB 15 minute
  const orb15 = runORB(days, 15, 1.5, 60, POINT_VALUE, 10, 200);
  orb15.name = 'ORB 15min (tgt=1.5x, stop=opposite)';
  allResults.orb_15m.push(orb15);
  printResult(orb15);

  // ORB 5 minute
  const orb5 = runORB(days, 5, 2.0, 45, POINT_VALUE, 5, 150);
  orb5.name = 'ORB 5min (tgt=2.0x, stop=opposite)';
  allResults.orb_5m.push(orb5);
  printResult(orb5);

  // ORB 30 minute
  const orb30 = runORB(days, 30, 1.0, 90, POINT_VALUE, 20, 300);
  orb30.name = 'ORB 30min (tgt=1.0x, stop=opposite)';
  allResults.orb_30m.push(orb30);
  printResult(orb30);

  // Random baseline (same stop/target as conservative VWAP)
  const rand = runRandom(days, 20, 15, 30, POINT_VALUE, 3);
  rand.name = 'RANDOM BASELINE (stop=20, tgt=15, 3/day)';
  allResults.random.push(rand);
  printResult(rand);
}

// ============================================================
// AGGREGATE RESULTS ACROSS SIMULATIONS
// ============================================================
console.log('\n\n============================================');
console.log('  AGGREGATE RESULTS (5 simulations)');
console.log('============================================');

function aggregateResults(name: string, results: StrategyResult[]): void {
  const avgWinRate = results.reduce((s, r) => s + r.winRate, 0) / results.length;
  const avgPF = results.reduce((s, r) => s + r.profitFactor, 0) / results.length;
  const avgPnl = results.reduce((s, r) => s + r.totalPnlDollars, 0) / results.length;
  const avgSharpe = results.reduce((s, r) => s + r.sharpeRatio, 0) / results.length;
  const avgDD = results.reduce((s, r) => s + r.maxDrawdownDollars, 0) / results.length;
  const avgTrades = results.reduce((s, r) => s + r.trades.length, 0) / results.length;

  const pnls = results.map(r => r.totalPnlDollars);
  const minPnl = Math.min(...pnls);
  const maxPnl = Math.max(...pnls);
  const profitableRuns = results.filter(r => r.totalPnlDollars > 0).length;

  const edge = avgPF > 1.3 ? 'YES - EDGE DETECTED' :
               avgPF > 1.1 ? 'MARGINAL EDGE' :
               avgPF > 0.9 ? 'NO EDGE (breakeven)' : 'NEGATIVE EDGE (losing)';

  console.log(`\n${name}`);
  console.log(`  Avg Win Rate: ${avgWinRate.toFixed(1)}%`);
  console.log(`  Avg Profit Factor: ${avgPF.toFixed(2)}`);
  console.log(`  Avg P&L: $${avgPnl.toFixed(2)}  (range: $${minPnl.toFixed(2)} to $${maxPnl.toFixed(2)})`);
  console.log(`  Avg Sharpe: ${avgSharpe.toFixed(2)}`);
  console.log(`  Avg Max DD: $${avgDD.toFixed(2)}`);
  console.log(`  Avg Trades: ${avgTrades.toFixed(0)}`);
  console.log(`  Profitable Runs: ${profitableRuns}/${results.length}`);
  console.log(`  VERDICT: ${edge}`);
}

aggregateResults('VWAP Mean Reversion - Conservative', allResults.vwap_conservative);
aggregateResults('VWAP Mean Reversion - Aggressive', allResults.vwap_aggressive);
aggregateResults('VWAP Mean Reversion - Wide', allResults.vwap_wide);
aggregateResults('Opening Range Breakout - 15min', allResults.orb_15m);
aggregateResults('Opening Range Breakout - 5min', allResults.orb_5m);
aggregateResults('Opening Range Breakout - 30min', allResults.orb_30m);
aggregateResults('Random Baseline', allResults.random);

// ============================================================
// MONTE CARLO: Is the edge statistically significant?
// ============================================================
console.log('\n\n============================================');
console.log('  MONTE CARLO SIGNIFICANCE TEST');
console.log('  (Shuffle trade results 10,000 times)');
console.log('============================================');

// Take the best-performing strategy and test if its P&L is
// significantly different from random by shuffling win/loss labels
const bestStrategy = (() => {
  const candidates = [
    { name: 'VWAP Conservative', results: allResults.vwap_conservative },
    { name: 'VWAP Aggressive', results: allResults.vwap_aggressive },
    { name: 'VWAP Wide', results: allResults.vwap_wide },
    { name: 'ORB 15min', results: allResults.orb_15m },
    { name: 'ORB 5min', results: allResults.orb_5m },
    { name: 'ORB 30min', results: allResults.orb_30m },
  ];
  let best = candidates[0];
  let bestPF = 0;
  for (const c of candidates) {
    const avgPF = c.results.reduce((s, r) => s + r.profitFactor, 0) / c.results.length;
    if (avgPF > bestPF) { bestPF = avgPF; best = c; }
  }
  return best;
})();

console.log(`\nTesting: ${bestStrategy.name}`);

// Combine all trades from best strategy across sims
const allTrades = bestStrategy.results.flatMap(r => r.trades);
const actualPnl = allTrades.reduce((s, t) => s + t.pnlDollars, 0);
const tradePnls = allTrades.map(t => t.pnlDollars);

console.log(`Actual total P&L: $${actualPnl.toFixed(2)} from ${allTrades.length} trades`);

// Shuffle test: randomly reassign P&L values and count how often random beats actual
const NUM_SHUFFLES = 10000;
let randomBetter = 0;

for (let s = 0; s < NUM_SHUFFLES; s++) {
  // Shuffle the P&L array
  const shuffled = [...tradePnls];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // Random subset (same number of trades, random P&L assignment)
  const randomPnl = shuffled.reduce((s, p) => s + p, 0);
  if (randomPnl >= actualPnl) randomBetter++;
}

const pValue = randomBetter / NUM_SHUFFLES;
console.log(`Monte Carlo p-value: ${pValue.toFixed(4)}`);
console.log(`Random beats strategy: ${randomBetter}/${NUM_SHUFFLES} times`);
console.log(`Statistical significance: ${pValue < 0.05 ? 'YES (p < 0.05)' : 'NO (p >= 0.05)'}`);

// ============================================================
// FINAL VERDICT
// ============================================================
console.log('\n\n============================================');
console.log('  FINAL VERDICT');
console.log('============================================');

const bestAvgPF = bestStrategy.results.reduce((s, r) => s + r.profitFactor, 0) / bestStrategy.results.length;
const randomAvgPF = allResults.random.reduce((s, r) => s + r.profitFactor, 0) / allResults.random.length;
const edgeDelta = bestAvgPF - randomAvgPF;

console.log(`\nBest strategy: ${bestStrategy.name}`);
console.log(`Best avg profit factor: ${bestAvgPF.toFixed(2)}`);
console.log(`Random baseline profit factor: ${randomAvgPF.toFixed(2)}`);
console.log(`Edge over random: ${edgeDelta.toFixed(2)}`);
console.log(`Monte Carlo p-value: ${pValue.toFixed(4)}`);

if (bestAvgPF > 1.3 && pValue < 0.05) {
  console.log('\nVERDICT: STRATEGY HAS A STATISTICALLY SIGNIFICANT EDGE');
  console.log('Recommendation: Proceed to live paper trading with real data');
} else if (bestAvgPF > 1.1 && pValue < 0.10) {
  console.log('\nVERDICT: MARGINAL EDGE DETECTED');
  console.log('Recommendation: Needs more data and parameter optimization before live trading');
} else if (bestAvgPF > 1.0) {
  console.log('\nVERDICT: NO SIGNIFICANT EDGE OVER RANDOM');
  console.log('Recommendation: Strategy does not justify the risk. Needs fundamental redesign.');
} else {
  console.log('\nVERDICT: STRATEGY IS A LOSER');
  console.log('Recommendation: Do NOT trade this. You will lose money.');
}

// Monthly P&L projection for $5K account, 1 MES contract
if (bestAvgPF > 1.0) {
  const avgMonthlyPnl = bestStrategy.results.reduce((s, r) => s + r.totalPnlDollars, 0) / bestStrategy.results.length / 6;
  const avgMonthlyDD = bestStrategy.results.reduce((s, r) => s + r.maxDrawdownDollars, 0) / bestStrategy.results.length;
  console.log(`\nProjected monthly P&L (1 MES): $${avgMonthlyPnl.toFixed(2)}`);
  console.log(`Projected 12-month P&L: $${(avgMonthlyPnl * 12).toFixed(2)}`);
  console.log(`Max drawdown risk: $${avgMonthlyDD.toFixed(2)}`);
  console.log(`As % of $5K account: ${(avgMonthlyDD / 5000 * 100).toFixed(1)}%`);
}
