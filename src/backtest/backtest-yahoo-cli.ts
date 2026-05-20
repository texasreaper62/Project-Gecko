// CLI: ORB backtest using Yahoo Finance data (no Schwab credentials needed).
//
// Usage:
//   npm run backtest:yahoo                              # default 10-symbol watchlist, 60d 5m bars
//   npm run backtest:yahoo -- --symbols=PLTR,SOFI       # custom symbols
//   npm run backtest:yahoo -- --equity=10000
//   npm run backtest:yahoo -- --interval=15m            # coarser bars
//
// Limits:
//   - Yahoo 5m bars: max 60 days of history per symbol.
//   - Yahoo rate-limits datacenter IPs; the fetcher throttles to one
//     request per 1.5 seconds. ~15 seconds total for a 10-symbol pass.
//
// Caveats:
//   - 5m bars coarsen the opening range (3 bars from 09:30-09:45 instead
//     of 15 with 1m). The strategy logic stays the same but slip and
//     stop-trigger timing are coarser. Treat results as directional, not
//     exact.
//   - Yahoo data quality is broadly accurate but not the same as Schwab's
//     consolidated tape. Pre-market volume in particular can be sparse.
//   - 60-day window is statistically thin. 95% CI on win rate at n=50
//     trades and p=0.45 is roughly +-14 percentage points.

import { createLogger, setLogLevel } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import { computeMetrics, formatMetricsReport, type BacktestTrade } from "./metrics.js";
import type { Bar } from "../core/types.js";

const log = createLogger("backtest-yahoo");

// Tuned for the kind of mid-cap gappers that ORB targets.
const DEFAULT_SYMBOLS: readonly string[] = [
  "PLTR", "SOFI", "AFRM", "MARA", "RIOT", "NIO", "RIVN", "GME", "AMC", "F",
];

// ORB constants (must mirror src/strategies/orb.ts).
const OR_START_MIN = 9 * 60 + 30;
const OR_END_MIN = 9 * 60 + 45;
const TRADE_CUTOFF_MIN = 11 * 60 + 30;
const OR_MIN_WIDTH_PCT = 0.5;
const OR_MAX_WIDTH_PCT = 5.0;
const RR_TARGET = 2;
const SLIPPAGE_PER_SIDE = 0.01;

const DEFAULT_MIN_GAP_PCT = 2.0;
const DEFAULT_MIN_PRICE = 5.0;
const DEFAULT_MAX_PRICE = 100.0;       // Wider than live config; many watchlist names recently above $50
const DEFAULT_RISK_PCT = 1.0;

interface Args {
  symbols: string[];
  equity: number;
  interval: "1m" | "5m" | "15m";
  minGapPct: number;
  maxConcurrent: number;
}

function parseArgs(): Args {
  const out: Args = {
    symbols: [...DEFAULT_SYMBOLS],
    equity: 5_000,
    interval: "5m",
    minGapPct: DEFAULT_MIN_GAP_PCT,
    maxConcurrent: 3,
  };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--symbols=")) {
      out.symbols = a.slice("--symbols=".length)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else if (a.startsWith("--equity=")) {
      out.equity = Number(a.slice("--equity=".length));
    } else if (a.startsWith("--interval=")) {
      const v = a.slice("--interval=".length) as Args["interval"];
      if (v === "1m" || v === "5m" || v === "15m") out.interval = v;
    } else if (a.startsWith("--gap=")) {
      out.minGapPct = Number(a.slice("--gap=".length));
    } else if (a.startsWith("--concurrent=")) {
      out.maxConcurrent = Number(a.slice("--concurrent=".length));
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  setLogLevel("info");

  const yahoo = new YahooHistoricalBars();
  const now = Date.now();
  const lookbackDays = args.interval === "1m" ? 7 : 60;
  const endMs = now;
  const startMs = now - lookbackDays * 24 * 60 * 60 * 1000;

  log.info("Yahoo backtest starting", {
    symbols: args.symbols.length,
    interval: args.interval,
    lookbackDays,
    startingEquity: args.equity,
    minGapPct: args.minGapPct,
    maxConcurrent: args.maxConcurrent,
  });

  // Pull bars for all symbols (Yahoo throttle is inside the fetcher).
  const bySymbol: Record<string, Bar[]> = {};
  for (const symbol of args.symbols) {
    try {
      const bars = await yahoo.fetch({
        symbol,
        interval: args.interval,
        startMs,
        endMs,
        includePrePost: true,
      });
      // Also pull daily bars for previous-close lookup.
      const dailyBars = await yahoo.fetch({
        symbol,
        interval: "1d",
        startMs: startMs - 5 * 24 * 60 * 60 * 1000,
        endMs,
        includePrePost: false,
      });
      bySymbol[symbol] = [...bars];
      bySymbol[`${symbol}__daily`] = [...dailyBars];
      log.info("Loaded bars", {
        symbol,
        intradayBars: bars.length,
        dailyBars: dailyBars.length,
        firstBarDate: bars[0] ? etParts(bars[0].timestamp).date : "n/a",
        lastBarDate: bars[bars.length - 1] ? etParts(bars[bars.length - 1].timestamp).date : "n/a",
      });
    } catch (err) {
      log.warn("Symbol fetch failed", { symbol, error: err instanceof Error ? err.message : String(err) });
      bySymbol[symbol] = [];
    }
  }

  // Now simulate ORB on each (symbol, day).
  // We process all trade candidates chronologically across the universe so the
  // maxConcurrent cap is enforced realistically.
  const dayKeys = new Set<string>();
  for (const symbol of args.symbols) {
    const bars = bySymbol[symbol] ?? [];
    for (const b of bars) dayKeys.add(etParts(b.timestamp).date);
  }
  const sortedDays = Array.from(dayKeys).sort();

  let equity = args.equity;
  const trades: BacktestTrade[] = [];

  for (const date of sortedDays) {
    // Build a per-day candidate list across all symbols.
    const candidates: { symbol: string; bars: Bar[]; prevClose: number }[] = [];
    for (const symbol of args.symbols) {
      const allBars = bySymbol[symbol] ?? [];
      const dailyBars = bySymbol[`${symbol}__daily`] ?? [];
      const dayBars = allBars.filter((b) => etParts(b.timestamp).date === date)
        .sort((a, b) => a.timestamp - b.timestamp);
      if (dayBars.length === 0) continue;

      const prevClose = previousDailyClose(dailyBars, date);
      if (prevClose === null) continue;

      candidates.push({ symbol, bars: dayBars, prevClose });
    }

    // Open positions track (for maxConcurrent enforcement during the day).
    // We'll process candidates in sequence: pick the first symbol whose breakout
    // triggers earliest in the day, fill it, then if we have headroom for another
    // concurrent position pick the next, etc. For simplicity, we cap per-day
    // trades at maxConcurrent (matches live behavior loosely).
    let opened = 0;
    for (const c of candidates) {
      if (opened >= args.maxConcurrent) break;
      const trade = simulateDay({
        symbol: c.symbol,
        date,
        prevClose: c.prevClose,
        bars: c.bars,
        equity,
        minGapPct: args.minGapPct,
      });
      if (trade) {
        trades.push(trade);
        equity += trade.pnl;
        opened++;
      }
    }
  }

  const metrics = computeMetrics(trades, args.equity);

  process.stdout.write("\n===== Yahoo ORB Backtest =====\n");
  process.stdout.write(`Symbols (${args.symbols.length}): ${args.symbols.join(", ")}\n`);
  process.stdout.write(`Interval:        ${args.interval}\n`);
  process.stdout.write(`Lookback:        ${lookbackDays} days\n`);
  process.stdout.write(`Trading days:    ${sortedDays.length}\n`);
  process.stdout.write(`Starting equity: $${args.equity}\n`);
  process.stdout.write(`Final equity:    $${equity.toFixed(2)}\n`);
  process.stdout.write(`Pct return:      ${((equity - args.equity) / args.equity * 100).toFixed(2)}%\n\n`);
  process.stdout.write(formatMetricsReport(metrics));
  process.stdout.write("\n\n");

  // Summarize by exit reason.
  const byReason: Record<string, { count: number; pnl: number }> = {};
  for (const t of trades) {
    const r = t.exitReason;
    if (!byReason[r]) byReason[r] = { count: 0, pnl: 0 };
    byReason[r].count++;
    byReason[r].pnl += t.pnl;
  }
  process.stdout.write("Exit reasons:\n");
  for (const [r, v] of Object.entries(byReason)) {
    process.stdout.write(`  ${r}: ${v.count} trades, $${v.pnl.toFixed(2)}\n`);
  }
  process.stdout.write("\n");

  // Top 5 winners and losers.
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  process.stdout.write("Top 5 winners:\n");
  for (const t of sorted.slice(0, 5)) {
    process.stdout.write(`  ${t.date} ${t.symbol} ${t.direction}: $${t.pnl.toFixed(2)} (${t.rMultiple.toFixed(1)}R, ${t.exitReason})\n`);
  }
  process.stdout.write("\nTop 5 losers:\n");
  for (const t of sorted.slice(-5).reverse()) {
    process.stdout.write(`  ${t.date} ${t.symbol} ${t.direction}: $${t.pnl.toFixed(2)} (${t.rMultiple.toFixed(1)}R, ${t.exitReason})\n`);
  }

  // Daily P&L breakdown.
  const byDate: Record<string, number> = {};
  for (const t of trades) {
    byDate[t.date] = (byDate[t.date] ?? 0) + t.pnl;
  }
  process.stdout.write("\nDaily P&L (last 15 days):\n");
  const dailySorted = Object.entries(byDate).sort();
  for (const [d, pnl] of dailySorted.slice(-15)) {
    const sign = pnl >= 0 ? "+" : "";
    process.stdout.write(`  ${d}: ${sign}$${pnl.toFixed(2)}\n`);
  }
}

function simulateDay(args: {
  readonly symbol: string;
  readonly date: string;
  readonly prevClose: number;
  readonly bars: readonly Bar[];
  readonly equity: number;
  readonly minGapPct: number;
}): BacktestTrade | null {
  const { symbol, date, prevClose, bars, equity, minGapPct } = args;

  // Find first regular-session bar.
  const firstRegular = bars.find((b) => minutesOfDayET(b.timestamp) >= OR_START_MIN);
  if (!firstRegular) return null;

  const openPrice = firstRegular.open;
  const gapPct = (openPrice - prevClose) / prevClose * 100;
  const absGap = Math.abs(gapPct);
  if (absGap < minGapPct) return null;
  if (openPrice < DEFAULT_MIN_PRICE || openPrice > DEFAULT_MAX_PRICE) return null;

  // Build opening range from bars in [09:30, 09:45).
  let orHigh = -Infinity;
  let orLow = Infinity;
  for (const b of bars) {
    const m = minutesOfDayET(b.timestamp);
    if (m >= OR_START_MIN && m < OR_END_MIN) {
      if (b.high > orHigh) orHigh = b.high;
      if (b.low < orLow) orLow = b.low;
    }
  }
  if (!Number.isFinite(orHigh) || !Number.isFinite(orLow)) return null;
  const midpoint = (orHigh + orLow) / 2;
  const orWidthPct = midpoint > 0 ? (orHigh - orLow) / midpoint * 100 : 0;
  if (orWidthPct < OR_MIN_WIDTH_PCT || orWidthPct > OR_MAX_WIDTH_PCT) return null;

  // Scan 09:45-11:30 for first breakout.
  const triggerBars = bars.filter((b) => {
    const m = minutesOfDayET(b.timestamp);
    return m >= OR_END_MIN && m < TRADE_CUTOFF_MIN;
  }).sort((a, b) => a.timestamp - b.timestamp);

  for (let i = 0; i < triggerBars.length; i++) {
    const b = triggerBars[i];
    let direction: "LONG" | "SHORT" | null = null;
    if (b.close > orHigh) direction = "LONG";
    else if (b.close < orLow) direction = "SHORT";
    if (!direction) continue;

    const next = triggerBars[i + 1];
    if (!next) return null;
    const entryPrice = direction === "LONG"
      ? next.open + SLIPPAGE_PER_SIDE
      : next.open - SLIPPAGE_PER_SIDE;
    const stop = direction === "LONG" ? orLow : orHigh;
    const stopDist = Math.abs(entryPrice - stop);
    if (stopDist <= 0) return null;

    const take = direction === "LONG"
      ? entryPrice + RR_TARGET * stopDist
      : entryPrice - RR_TARGET * stopDist;

    const riskUsd = equity * DEFAULT_RISK_PCT / 100;
    const shares = Math.floor(riskUsd / stopDist);
    if (shares <= 0) return null;

    // Walk forward to resolve.
    for (let j = i + 1; j < triggerBars.length; j++) {
      const fwd = triggerBars[j];
      const fwdMin = minutesOfDayET(fwd.timestamp);

      if (direction === "LONG") {
        if (fwd.low <= stop) {
          const exit = stop - SLIPPAGE_PER_SIDE;
          return makeTrade(symbol, date, direction, entryPrice, exit, stop, take, shares, "stop", fwd.timestamp, b.timestamp);
        }
        if (fwd.high >= take) {
          const exit = take - SLIPPAGE_PER_SIDE;
          return makeTrade(symbol, date, direction, entryPrice, exit, stop, take, shares, "take", fwd.timestamp, b.timestamp);
        }
      } else {
        if (fwd.high >= stop) {
          const exit = stop + SLIPPAGE_PER_SIDE;
          return makeTrade(symbol, date, direction, entryPrice, exit, stop, take, shares, "stop", fwd.timestamp, b.timestamp);
        }
        if (fwd.low <= take) {
          const exit = take + SLIPPAGE_PER_SIDE;
          return makeTrade(symbol, date, direction, entryPrice, exit, stop, take, shares, "take", fwd.timestamp, b.timestamp);
        }
      }

      if (fwdMin >= TRADE_CUTOFF_MIN) {
        const exit = direction === "LONG" ? fwd.close - SLIPPAGE_PER_SIDE : fwd.close + SLIPPAGE_PER_SIDE;
        return makeTrade(symbol, date, direction, entryPrice, exit, stop, take, shares, "time", fwd.timestamp, b.timestamp);
      }
    }
    const last = triggerBars[triggerBars.length - 1];
    const exit = direction === "LONG" ? last.close - SLIPPAGE_PER_SIDE : last.close + SLIPPAGE_PER_SIDE;
    return makeTrade(symbol, date, direction, entryPrice, exit, stop, take, shares, "eod", last.timestamp, b.timestamp);
  }
  return null;
}

function makeTrade(
  symbol: string,
  date: string,
  direction: "LONG" | "SHORT",
  entryPrice: number,
  exitPrice: number,
  stop: number,
  take: number,
  shares: number,
  exitReason: BacktestTrade["exitReason"],
  exitTime: number,
  entryTime: number,
): BacktestTrade {
  const directionMul = direction === "LONG" ? 1 : -1;
  const pnl = (exitPrice - entryPrice) * shares * directionMul;
  const stopDist = Math.abs(entryPrice - stop);
  const rMultiple = stopDist > 0 ? (exitPrice - entryPrice) * directionMul / stopDist : 0;
  return {
    date, symbol, direction, entryPrice, exitPrice, stop, take, shares,
    pnl, rMultiple, exitReason, entryTime, exitTime,
  };
}

function previousDailyClose(dailyBars: readonly Bar[], date: string): number | null {
  let best: Bar | null = null;
  let bestDate = "";
  for (const b of dailyBars) {
    const d = etParts(b.timestamp).date;
    if (d < date && d > bestDate) {
      bestDate = d;
      best = b;
    }
  }
  return best?.close ?? null;
}

function minutesOfDayET(ts: number): number {
  const p = etParts(ts);
  return p.hour * 60 + p.minute;
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
