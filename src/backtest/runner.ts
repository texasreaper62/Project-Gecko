// Event-driven ORB backtester. Replays historical 1-minute bars and
// simulates Engine A entry / stop / take-profit / time-stop logic.
//
// Scope: equities only (Engine A). Engine B requires historical option
// chains which we'd need a separate data source for; deferred.
//
// Approach:
//   For each (date, symbol):
//     1. Pull 1-min bars from extended hours start (04:00 ET) through 16:00 ET
//     2. Find previous trading day's close from a separate daily fetch
//     3. Compute premarket gap from previous close vs first 9:30 ET open
//     4. Skip if gap filter, volume filter, or price filter fails
//     5. Build opening range from 9:30-9:45 ET high/low across bars
//     6. From 9:45-11:30, on first 1-min close above OR high (long) or
//        below OR low (short), simulate entry at next bar's open
//     7. Walk forward bar-by-bar until stop, take, or 11:30 time-stop
//     8. Record the trade outcome
//
// Fills assume: entry at next-bar open, stop/take hits at the intra-bar
// low/high crossing the level. Slippage of 1 tick (configurable) per side
// applied. Simple but realistic for a $5-50 share range.

import { createLogger } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import type { AppConfig, Bar } from "../core/types.js";
import type { HistoricalBars } from "../data/historical.js";
import type { BacktestTrade } from "./metrics.js";

const log = createLogger("backtest");

const OR_START_MIN = 9 * 60 + 30;
const OR_END_MIN = 9 * 60 + 45;
const TRADE_CUTOFF_MIN = 11 * 60 + 30;
const OR_MIN_WIDTH_PCT = 0.5;
const OR_MAX_WIDTH_PCT = 5.0;
const RR_TARGET = 2;
const SLIPPAGE_PER_SIDE = 0.01;       // $0.01 each on entry and exit
const STARTING_EQUITY_DEFAULT = 5_000;

export interface BacktestOptions {
  readonly symbols: readonly string[];
  readonly startDate: string;         // YYYY-MM-DD
  readonly endDate: string;           // YYYY-MM-DD
  readonly startingEquity?: number;
  readonly maxTradesPerDay?: number;
}

export class OrbBacktester {
  constructor(
    private readonly config: AppConfig,
    private readonly historical: HistoricalBars,
  ) {}

  async run(options: BacktestOptions): Promise<readonly BacktestTrade[]> {
    const startingEquity = options.startingEquity ?? STARTING_EQUITY_DEFAULT;
    const trades: BacktestTrade[] = [];
    let equity = startingEquity;

    const startMs = parseDate(options.startDate);
    const endMs = parseDate(options.endDate) + 24 * 60 * 60 * 1000;

    log.info("Backtest starting", {
      symbols: options.symbols.length,
      startDate: options.startDate,
      endDate: options.endDate,
      startingEquity,
    });

    for (const symbol of options.symbols) {
      log.info("Loading bars", { symbol });
      const minuteBars = await this.historical.fetch({
        symbol,
        frequencyType: "minute",
        frequency: 1,
        startMs,
        endMs,
        extendedHours: true,
      });
      const dailyBars = await this.historical.fetch({
        symbol,
        frequencyType: "daily",
        frequency: 1,
        startMs: startMs - 5 * 24 * 60 * 60 * 1000,
        endMs,
        extendedHours: false,
      });

      const byDay = groupBarsByDay(minuteBars);
      const dailyByDate = new Map(dailyBars.map((b) => [etParts(b.timestamp).date, b]));

      const sortedDates = Array.from(byDay.keys()).sort();
      for (const date of sortedDates) {
        const dayBars = byDay.get(date) ?? [];
        const dailyBar = dailyByDate.get(date);
        if (!dailyBar) continue;

        // Previous close from the daily series.
        const prevClose = previousClose(dailyBars, date);
        if (prevClose === null) continue;

        const trade = this.simulateDay({
          symbol,
          date,
          prevClose,
          bars: dayBars,
          equity,
        });
        if (trade) {
          trades.push(trade);
          equity += trade.pnl;
        }
      }
    }

    log.info("Backtest complete", {
      totalTrades: trades.length,
      finalEquity: equity,
    });
    return trades;
  }

  private simulateDay(args: {
    readonly symbol: string;
    readonly date: string;
    readonly prevClose: number;
    readonly bars: readonly Bar[];
    readonly equity: number;
  }): BacktestTrade | null {
    const { symbol, date, prevClose, bars, equity } = args;
    if (bars.length === 0) return null;

    // Find the 09:30 bar (the first bar at OR_START_MIN ET).
    const firstRegular = bars.find((b) => minutesOfDayET(b.timestamp) >= OR_START_MIN);
    if (!firstRegular) return null;

    const openPrice = firstRegular.open;
    const gapPct = (openPrice - prevClose) / prevClose * 100;
    const absGap = Math.abs(gapPct);
    if (absGap < this.config.orbMinGapPct) return null;
    if (openPrice < this.config.orbMinPrice || openPrice > this.config.orbMaxPrice) return null;

    // Opening range from 9:30-9:45.
    let orHigh = -Infinity;
    let orLow = Infinity;
    const orBars = bars.filter((b) => {
      const m = minutesOfDayET(b.timestamp);
      return m >= OR_START_MIN && m < OR_END_MIN;
    });
    if (orBars.length === 0) return null;
    for (const b of orBars) {
      if (b.high > orHigh) orHigh = b.high;
      if (b.low < orLow) orLow = b.low;
    }
    const midpoint = (orHigh + orLow) / 2;
    const orWidthPct = midpoint > 0 ? (orHigh - orLow) / midpoint * 100 : 0;
    if (orWidthPct < OR_MIN_WIDTH_PCT || orWidthPct > OR_MAX_WIDTH_PCT) return null;

    // Scan 9:45-11:30 for first breakout.
    const triggerBars = bars.filter((b) => {
      const m = minutesOfDayET(b.timestamp);
      return m >= OR_END_MIN && m < TRADE_CUTOFF_MIN;
    });

    for (let i = 0; i < triggerBars.length; i++) {
      const b = triggerBars[i];
      let direction: "LONG" | "SHORT" | null = null;
      if (b.close > orHigh) direction = "LONG";
      else if (b.close < orLow) direction = "SHORT";
      if (!direction) continue;

      // Enter at next bar's open (no look-ahead).
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

      const riskUsd = equity * this.config.maxRiskPerTradePct / 100;
      const shares = Math.floor(riskUsd / stopDist);
      if (shares <= 0) return null;

      // Walk forward to resolve the trade.
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

      // Reached end of bars without exit.
      const last = triggerBars[triggerBars.length - 1];
      const exit = direction === "LONG" ? last.close - SLIPPAGE_PER_SIDE : last.close + SLIPPAGE_PER_SIDE;
      return makeTrade(symbol, date, direction, entryPrice, exit, stop, take, shares, "eod", last.timestamp, b.timestamp);
    }

    return null;
  }
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
    date,
    symbol,
    direction,
    entryPrice,
    exitPrice,
    stop,
    take,
    shares,
    pnl,
    rMultiple,
    exitReason,
    entryTime,
    exitTime,
  };
}

function groupBarsByDay(bars: readonly Bar[]): Map<string, Bar[]> {
  const m = new Map<string, Bar[]>();
  for (const b of bars) {
    const date = etParts(b.timestamp).date;
    const list = m.get(date) ?? [];
    list.push(b);
    m.set(date, list);
  }
  // Ensure each day's bars are sorted by timestamp.
  for (const list of m.values()) list.sort((a, b) => a.timestamp - b.timestamp);
  return m;
}

function previousClose(dailyBars: readonly Bar[], date: string): number | null {
  // Find the daily bar with date < `date` and the largest date.
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

function parseDate(yyyymmdd: string): number {
  // Parse as UTC midnight; the day boundary is fine for selecting the
  // historical fetch window.
  return new Date(`${yyyymmdd}T00:00:00Z`).getTime();
}
