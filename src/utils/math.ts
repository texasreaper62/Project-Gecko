// Spread between two prices as a percentage
export function spreadPercent(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const mid = (a + b) / 2;
  if (mid === 0) return 0;
  return Math.abs(a - b) / mid * 100;
}

// Implied probability from a binary contract price (0-1 range)
export function impliedProbability(price: number): number {
  return Math.max(0, Math.min(1, price));
}

// Calculate edge: difference between estimated true probability and market probability
export function edgePercent(trueProbability: number, marketProbability: number): number {
  return (trueProbability - marketProbability) * 100;
}

// Round a price to the given tick size (e.g., 0.01 for cents)
export function roundToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
  return Math.round(price / tickSize) * tickSize;
}

// Convert USDC amount to contract units (6 decimals)
export function usdcToUnits(usdc: number): bigint {
  return BigInt(Math.round(usdc * 1_000_000));
}

// Convert contract units to USDC
export function unitsToUsdc(units: bigint): number {
  return Number(units) / 1_000_000;
}

// Calculate order book depth in USDC from levels
export function calculateDepth(levels: readonly { price: number; size: number }[]): number {
  let total = 0;
  for (const level of levels) {
    total += level.price * level.size;
  }
  return total;
}

// Sum of YES prices across outcomes (for correlated contracts)
export function sumProbabilities(prices: readonly number[]): number {
  let sum = 0;
  for (const p of prices) {
    sum += p;
  }
  return sum;
}

// Clamp a value between min and max
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Simple moving average over recent values
export function sma(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

// Price momentum: average rate of change per ms
export function priceMomentum(prices: readonly { price: number; timestamp: number }[]): number {
  if (prices.length < 2) return 0;
  const first = prices[0];
  const last = prices[prices.length - 1];
  const dt = last.timestamp - first.timestamp;
  if (dt === 0) return 0;
  return (last.price - first.price) / dt;
}
