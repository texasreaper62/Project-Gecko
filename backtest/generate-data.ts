/**
 * Generate realistic synthetic NQ futures intraday data.
 *
 * Based on documented NQ statistical properties:
 * - Average daily range: 200-400 NQ points
 * - Mean reversion around VWAP during range-bound days (~60% of days)
 * - Strong trends on ~25% of days (FOMC, CPI, momentum)
 * - Choppy/random noise on ~15% of days
 * - Higher volatility in first 30 min and last 30 min of RTH
 * - Volatility clustering (high vol days tend to cluster)
 *
 * Each bar: 1-minute OHLCV during RTH (9:30-16:00 ET = 390 bars/day)
 */

interface Bar {
  timestamp: number;   // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;        // Running VWAP for the day
}

interface DayData {
  date: string;
  regime: 'mean_revert' | 'trend_up' | 'trend_down' | 'chop';
  bars: Bar[];
  dailyRange: number;
  openPrice: number;
  closePrice: number;
}

function gaussianRandom(): number {
  // Box-Muller transform
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function generateDay(
  date: string,
  openPrice: number,
  prevVolatility: number
): DayData {
  // Determine day regime
  const roll = Math.random();
  let regime: DayData['regime'];
  if (roll < 0.30) regime = 'mean_revert';       // 30% strong mean reversion
  else if (roll < 0.60) regime = 'mean_revert';   // another 30% mild mean reversion
  else if (roll < 0.75) regime = 'trend_up';       // 15% trend up
  else if (roll < 0.90) regime = 'trend_down';     // 15% trend down
  else regime = 'chop';                            // 10% choppy

  // Daily volatility (NQ daily range 150-500 points, avg ~250)
  const baseVol = 0.008; // ~0.8% daily move on NQ ~20000
  const volMultiplier = regime === 'chop' ? 0.5 :
                        regime === 'mean_revert' ? 0.7 :
                        1.3; // trends are higher vol
  const dailyVol = baseVol * volMultiplier * (0.7 + Math.random() * 0.6);

  // Per-minute volatility
  const minuteVol = dailyVol / Math.sqrt(390);

  const bars: Bar[] = [];
  let price = openPrice;
  let cumVolPrice = 0;
  let cumVol = 0;
  const dayOpen = openPrice;

  // For mean reversion: VWAP anchor
  let vwapAnchor = openPrice;

  // For trend: drift direction
  const trendDrift = regime === 'trend_up' ? dailyVol / 390 * 0.15 :
                     regime === 'trend_down' ? -dailyVol / 390 * 0.15 :
                     0;

  for (let i = 0; i < 390; i++) {
    const minuteOfDay = i;
    const hour = Math.floor(minuteOfDay / 60);

    // Intraday volatility smile: higher at open and close
    let volScale = 1.0;
    if (minuteOfDay < 30) volScale = 2.0 - (minuteOfDay / 30);    // First 30 min: 2x -> 1x
    else if (minuteOfDay > 360) volScale = 1.0 + (minuteOfDay - 360) / 30; // Last 30 min: 1x -> 2x
    else if (minuteOfDay < 60) volScale = 1.0;                      // Normal
    else volScale = 0.8 + Math.random() * 0.4;                     // Mid-day: lower vol

    const noise = gaussianRandom() * minuteVol * price * volScale;

    // Mean reversion force toward VWAP
    let meanRevForce = 0;
    if (regime === 'mean_revert' && cumVol > 0) {
      const currentVwap = cumVolPrice / cumVol;
      const deviation = (price - currentVwap) / currentVwap;
      // Stronger pull when further from VWAP
      meanRevForce = -deviation * price * 0.02;
    }

    // Trend drift
    const drift = trendDrift * price;

    // Chop: random walk with no drift, slightly higher noise
    const chopExtra = regime === 'chop' ? gaussianRandom() * minuteVol * price * 0.3 : 0;

    const priceChange = noise + meanRevForce + drift + chopExtra;
    const newPrice = price + priceChange;

    // Generate OHLC from price move
    const barOpen = price;
    const barClose = newPrice;
    const barHigh = Math.max(barOpen, barClose) + Math.abs(gaussianRandom() * minuteVol * price * 0.3);
    const barLow = Math.min(barOpen, barClose) - Math.abs(gaussianRandom() * minuteVol * price * 0.3);

    // Volume: higher at open/close, lower mid-day
    let baseVolume = 5000 + Math.random() * 3000;
    if (minuteOfDay < 30) baseVolume *= 3;
    else if (minuteOfDay > 360) baseVolume *= 2.5;
    else if (minuteOfDay > 180 && minuteOfDay < 240) baseVolume *= 0.5; // lunch lull

    const volume = Math.round(baseVolume);

    // Update VWAP
    const typicalPrice = (barHigh + barLow + barClose) / 3;
    cumVolPrice += typicalPrice * volume;
    cumVol += volume;
    const vwap = cumVolPrice / cumVol;

    // Create timestamp (using 2026-03 dates, 9:30 ET = 14:30 UTC)
    const [year, month, day] = date.split('-').map(Number);
    const baseMs = new Date(year, month - 1, day, 9, 30, 0).getTime();
    const timestamp = baseMs + i * 60000;

    bars.push({
      timestamp,
      open: Math.round(barOpen * 100) / 100,
      high: Math.round(barHigh * 100) / 100,
      low: Math.round(barLow * 100) / 100,
      close: Math.round(barClose * 100) / 100,
      volume,
      vwap: Math.round(vwap * 100) / 100
    });

    price = newPrice;
  }

  const dailyHigh = Math.max(...bars.map(b => b.high));
  const dailyLow = Math.min(...bars.map(b => b.low));

  return {
    date,
    regime,
    bars,
    dailyRange: dailyHigh - dailyLow,
    openPrice: dayOpen,
    closePrice: bars[bars.length - 1].close
  };
}

function generateDataset(numDays: number): DayData[] {
  const days: DayData[] = [];
  let price = 20000; // NQ starting price
  let prevVol = 0.008;

  // Generate trading days
  const startDate = new Date(2026, 0, 5); // Jan 5, 2026 (Monday)
  let currentDate = startDate;

  for (let d = 0; d < numDays; d++) {
    // Skip weekends
    while (currentDate.getDay() === 0 || currentDate.getDay() === 6) {
      currentDate = new Date(currentDate.getTime() + 86400000);
    }

    const dateStr = currentDate.toISOString().split('T')[0];

    // Gap from previous close (NQ overnight moves: -0.5% to +0.5%)
    const gap = gaussianRandom() * 0.003 * price;
    price += gap;

    const day = generateDay(dateStr, price, prevVol);
    days.push(day);

    price = day.closePrice;
    prevVol = day.dailyRange / day.openPrice;

    currentDate = new Date(currentDate.getTime() + 86400000);
  }

  return days;
}

// Generate 120 trading days (~6 months)
const dataset = generateDataset(120);

// Summary stats
const regimeCounts = { mean_revert: 0, trend_up: 0, trend_down: 0, chop: 0 };
const ranges: number[] = [];
for (const day of dataset) {
  regimeCounts[day.regime]++;
  ranges.push(day.dailyRange);
}

console.log('\n=== SYNTHETIC NQ DATA GENERATED ===');
console.log(`Days: ${dataset.length}`);
console.log(`Total bars: ${dataset.reduce((s, d) => s + d.bars.length, 0)}`);
console.log(`Regimes: ${JSON.stringify(regimeCounts)}`);
console.log(`Avg daily range: ${(ranges.reduce((s, r) => s + r, 0) / ranges.length).toFixed(1)} points`);
console.log(`Min daily range: ${Math.min(...ranges).toFixed(1)}`);
console.log(`Max daily range: ${Math.max(...ranges).toFixed(1)}`);
console.log(`Price range: ${dataset[0].openPrice.toFixed(0)} -> ${dataset[dataset.length - 1].closePrice.toFixed(0)}`);

// Save to file
const fs = require('fs');
const outputPath = '/home/user/Project-Gecko/data/nq_synthetic.json';
fs.writeFileSync(outputPath, JSON.stringify(dataset));
console.log(`\nSaved to ${outputPath}`);
console.log(`File size: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)} MB`);
