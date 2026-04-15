/**
 * GEX-Filtered VWAP Scalping Backtest
 *
 * THE KEY QUESTION: On positive GEX days, can VWAP scalping
 * on SPY/MES consistently produce $75+/day?
 *
 * Tests multiple parameter sets across 500 simulated trading days
 * (10 independent runs of 50 days each for statistical robustness).
 *
 * Results are broken out by GEX regime to prove the filtering works.
 */

import { generateMarketData, TradingDay } from './market-model.js';
import { runVwapScalper, DayResult, StrategyParams } from './vwap-scalper-strategy.js';

// ============================================================
// PARAMETER SETS TO TEST
// ============================================================
const paramSets: { name: string; params: StrategyParams }[] = [
  {
    name: 'Conservative (MES 1ct, $0.80 dev, 60% target, 1.5x stop)',
    params: {
      entryDeviation: 0.80,
      targetPercent: 0.60,
      stopMultiple: 1.5,
      maxHoldBars: 30,
      maxTradingMinute: 119,
      minTradingMinute: 5,
      dailyLossLimit: -150,
      pointValue: 5,     // MES = $5/point
      contracts: 1,
      commissionPerTrade: 1.24,  // MES round-trip on IBKR
    }
  },
  {
    name: 'Moderate (MES 1ct, $0.60 dev, 65% target, 1.3x stop)',
    params: {
      entryDeviation: 0.60,
      targetPercent: 0.65,
      stopMultiple: 1.3,
      maxHoldBars: 25,
      maxTradingMinute: 119,
      minTradingMinute: 5,
      dailyLossLimit: -150,
      pointValue: 5,
      contracts: 1,
      commissionPerTrade: 1.24,
    }
  },
  {
    name: 'Aggressive (MES 1ct, $0.50 dev, 70% target, 1.2x stop)',
    params: {
      entryDeviation: 0.50,
      targetPercent: 0.70,
      stopMultiple: 1.2,
      maxHoldBars: 20,
      maxTradingMinute: 119,
      minTradingMinute: 5,
      dailyLossLimit: -150,
      pointValue: 5,
      contracts: 1,
      commissionPerTrade: 1.24,
    }
  },
  {
    name: 'Wide (MES 1ct, $1.00 dev, 55% target, 1.8x stop)',
    params: {
      entryDeviation: 1.00,
      targetPercent: 0.55,
      stopMultiple: 1.8,
      maxHoldBars: 40,
      maxTradingMinute: 119,
      minTradingMinute: 5,
      dailyLossLimit: -150,
      pointValue: 5,
      contracts: 1,
      commissionPerTrade: 1.24,
    }
  },
  {
    name: '2-Contract Moderate (MES 2ct, $0.60 dev)',
    params: {
      entryDeviation: 0.60,
      targetPercent: 0.65,
      stopMultiple: 1.3,
      maxHoldBars: 25,
      maxTradingMinute: 119,
      minTradingMinute: 5,
      dailyLossLimit: -150,
      pointValue: 5,
      contracts: 2,
      commissionPerTrade: 2.48,
    }
  },
  {
    name: 'Full Day Moderate (MES 1ct, trades all day)',
    params: {
      entryDeviation: 0.60,
      targetPercent: 0.65,
      stopMultiple: 1.3,
      maxHoldBars: 25,
      maxTradingMinute: 375,  // Trade almost all day
      minTradingMinute: 5,
      dailyLossLimit: -150,
      pointValue: 5,
      contracts: 1,
      commissionPerTrade: 1.24,
    }
  },
];

// ============================================================
// RUN SIMULATIONS
// ============================================================
const NUM_SIMS = 10;
const DAYS_PER_SIM = 50;

console.log('=====================================================');
console.log('  GEX-FILTERED VWAP SCALPING BACKTEST');
console.log(`  ${NUM_SIMS} simulations x ${DAYS_PER_SIM} days = ${NUM_SIMS * DAYS_PER_SIM} total days`);
console.log('  MES contract: $5/point');
console.log('  Testing whether $75/day is achievable on positive GEX days');
console.log('=====================================================\n');

for (const { name, params } of paramSets) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  STRATEGY: ${name}`);
  console.log(`${'='.repeat(60)}`);

  const allResults: DayResult[] = [];

  for (let sim = 0; sim < NUM_SIMS; sim++) {
    const days = generateMarketData(DAYS_PER_SIM);
    const results = runVwapScalper(days, params);
    allResults.push(...results);
  }

  // Separate by regime
  const byRegime: Record<string, DayResult[]> = {
    positive: allResults.filter(r => r.regime === 'positive'),
    negative: allResults.filter(r => r.regime === 'negative'),
    neutral: allResults.filter(r => r.regime === 'neutral'),
    all: allResults,
  };

  // Also test: what if we ONLY trade positive GEX days?
  const positiveOnly = byRegime.positive;
  const allDays = byRegime.all;

  for (const [regime, days] of Object.entries(byRegime)) {
    if (days.length === 0) continue;

    const tradingDays = days.filter(d => d.trades.length > 0);
    const profitableDays = days.filter(d => d.totalPnlDollars > 0);
    const above75 = days.filter(d => d.totalPnlDollars >= 75);
    const above150 = days.filter(d => d.totalPnlDollars >= 150);

    const totalPnl = days.reduce((s, d) => s + d.totalPnlDollars, 0);
    const avgDailyPnl = totalPnl / days.length;
    const totalTrades = days.reduce((s, d) => s + d.trades.length, 0);
    const totalWins = days.reduce((s, d) => s + d.winCount, 0);
    const totalLosses = days.reduce((s, d) => s + d.lossCount, 0);

    // Daily P&L distribution
    const dailyPnls = days.map(d => d.totalPnlDollars).sort((a, b) => a - b);
    const p10 = dailyPnls[Math.floor(days.length * 0.10)];
    const p25 = dailyPnls[Math.floor(days.length * 0.25)];
    const p50 = dailyPnls[Math.floor(days.length * 0.50)];
    const p75 = dailyPnls[Math.floor(days.length * 0.75)];
    const p90 = dailyPnls[Math.floor(days.length * 0.90)];

    // Sharpe (annualized from daily)
    const avgDaily = dailyPnls.reduce((s, p) => s + p, 0) / dailyPnls.length;
    const stdDaily = Math.sqrt(
      dailyPnls.reduce((s, p) => s + (p - avgDaily) ** 2, 0) / (dailyPnls.length - 1)
    );
    const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

    // Max consecutive losing days
    let maxConsecLoss = 0;
    let currentConsecLoss = 0;
    for (const d of days) {
      if (d.totalPnlDollars < 0) {
        currentConsecLoss++;
        maxConsecLoss = Math.max(maxConsecLoss, currentConsecLoss);
      } else {
        currentConsecLoss = 0;
      }
    }

    const label = regime === 'all' ? 'ALL DAYS' :
                  regime === 'positive' ? 'POSITIVE GEX ONLY ***' :
                  regime === 'negative' ? 'NEGATIVE GEX' : 'NEUTRAL';

    console.log(`\n  --- ${label} (${days.length} days) ---`);
    console.log(`  Total P&L: $${totalPnl.toFixed(2)}`);
    console.log(`  Avg Daily P&L: $${avgDailyPnl.toFixed(2)}`);
    console.log(`  Trades: ${totalTrades} (${(totalTrades / days.length).toFixed(1)}/day) | Wins: ${totalWins} | Losses: ${totalLosses}`);
    console.log(`  Win Rate: ${totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0}%`);
    console.log(`  Profitable Days: ${profitableDays.length}/${days.length} (${((profitableDays.length / days.length) * 100).toFixed(1)}%)`);
    console.log(`  Days >= $75: ${above75.length}/${days.length} (${((above75.length / days.length) * 100).toFixed(1)}%)`);
    console.log(`  Days >= $150: ${above150.length}/${days.length} (${((above150.length / days.length) * 100).toFixed(1)}%)`);
    console.log(`  Sharpe Ratio: ${sharpe.toFixed(2)}`);
    console.log(`  Max Consec Losing Days: ${maxConsecLoss}`);
    console.log(`  Daily P&L Distribution: P10=$${p10.toFixed(0)} P25=$${p25.toFixed(0)} P50=$${p50.toFixed(0)} P75=$${p75.toFixed(0)} P90=$${p90.toFixed(0)}`);

    if (regime === 'positive') {
      // Extra analysis for positive GEX
      const monthlyEstimate = avgDailyPnl * 12; // ~12 positive GEX trading days per month (58% of 22)
      console.log(`  >>> MONTHLY ESTIMATE (12 days/month): $${monthlyEstimate.toFixed(2)}`);
      console.log(`  >>> AS % OF $5K ACCOUNT: ${((monthlyEstimate / 5000) * 100).toFixed(1)}%`);

      const hits75Target = avgDailyPnl >= 75;
      console.log(`  >>> HITS $75/DAY TARGET: ${hits75Target ? 'YES' : 'NO'} (avg: $${avgDailyPnl.toFixed(2)})`);
    }
  }

  // THE KEY METRIC: What's the expected monthly return if we ONLY trade positive GEX days?
  const positiveDays = byRegime.positive;
  const posAvg = positiveDays.reduce((s, d) => s + d.totalPnlDollars, 0) / positiveDays.length;
  const negDays = byRegime.negative;
  const negAvg = negDays.length > 0 ? negDays.reduce((s, d) => s + d.totalPnlDollars, 0) / negDays.length : 0;

  console.log(`\n  *** REGIME COMPARISON ***`);
  console.log(`  Positive GEX avg daily: $${posAvg.toFixed(2)}`);
  console.log(`  Negative GEX avg daily: $${negAvg.toFixed(2)}`);
  console.log(`  GEX filter value: $${(posAvg - negAvg).toFixed(2)}/day improvement`);
  console.log(`  Filter eliminates: ${((1 - positiveDays.length / allResults.length) * 100).toFixed(0)}% of trading days`);
}

// ============================================================
// FINAL SUMMARY: GO/NO-GO DECISION
// ============================================================
console.log('\n\n' + '='.repeat(60));
console.log('  FINAL VERDICT: IS $75/DAY ACHIEVABLE?');
console.log('='.repeat(60));

// Run the "Moderate" strategy (best candidate) one more time with 1000 days
const finalDays = generateMarketData(1000);
const finalParams = paramSets[1].params; // Moderate
const finalResults = runVwapScalper(finalDays, finalParams);

const posGex = finalResults.filter(r => r.regime === 'positive');
const negGex = finalResults.filter(r => r.regime === 'negative');
const allFinal = finalResults;

const posAvg = posGex.reduce((s, d) => s + d.totalPnlDollars, 0) / posGex.length;
const negAvg = negGex.reduce((s, d) => s + d.totalPnlDollars, 0) / negGex.length;
const allAvg = allFinal.reduce((s, d) => s + d.totalPnlDollars, 0) / allFinal.length;
const posWinDays = posGex.filter(d => d.totalPnlDollars > 0).length;
const posAbove75 = posGex.filter(d => d.totalPnlDollars >= 75).length;

console.log(`\n  1000-Day Final Test (Moderate strategy):`);
console.log(`  Positive GEX days: ${posGex.length}`);
console.log(`  Positive GEX avg P&L: $${posAvg.toFixed(2)}/day`);
console.log(`  Positive GEX profitable days: ${posWinDays}/${posGex.length} (${((posWinDays / posGex.length) * 100).toFixed(1)}%)`);
console.log(`  Positive GEX days >= $75: ${posAbove75}/${posGex.length} (${((posAbove75 / posGex.length) * 100).toFixed(1)}%)`);
console.log(`  Negative GEX avg P&L: $${negAvg.toFixed(2)}/day`);
console.log(`  Unfiltered avg P&L: $${allAvg.toFixed(2)}/day`);
console.log(`  GEX filter improvement: $${(posAvg - allAvg).toFixed(2)}/day`);

const monthlyGexFiltered = posAvg * 12; // ~12 positive GEX days per month
const monthlyUnfiltered = allAvg * 22; // 22 trading days
console.log(`\n  Monthly projection (GEX-filtered, ~12 days): $${monthlyGexFiltered.toFixed(2)}`);
console.log(`  Monthly projection (unfiltered, ~22 days): $${monthlyUnfiltered.toFixed(2)}`);
console.log(`  As % of $5K account (filtered): ${((monthlyGexFiltered / 5000) * 100).toFixed(1)}%`);
console.log(`  As % of $5K account (unfiltered): ${((monthlyUnfiltered / 5000) * 100).toFixed(1)}%`);

if (posAvg >= 75) {
  console.log(`\n  *** VERDICT: YES -- $75/day target is achievable on positive GEX days ***`);
  console.log(`  *** The scalping engine can serve as Engine 1 ***`);
} else if (posAvg >= 50) {
  console.log(`\n  ** VERDICT: CLOSE -- $${posAvg.toFixed(0)}/day avg. Consider 2 contracts or wider trading window **`);
} else if (posAvg > 0) {
  console.log(`\n  * VERDICT: MARGINAL -- $${posAvg.toFixed(0)}/day avg. Edge exists but below target *`);
} else {
  console.log(`\n  VERDICT: NO -- Strategy is not profitable. Do not proceed.`);
}
