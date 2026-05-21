// Empirical test of the Microscalper signal validity.
//
// Pulls 7d of SPY 1-min bars and checks:
//   1. How often does price deviate >0.18% from 5-min rolling VWAP?
//   2. After such a deviation, what fraction revert to VWAP within 10 min?
//   3. What's the average move size to reversion vs against?
//
// This is the cleanest test of the strategy's core signal without
// any leverage layer. If the equity signal doesn't have an edge,
// the option layer cannot save it.

import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import { etParts } from "../utils/time.js";
import type { Bar } from "../core/types.js";

interface Deviation {
  readonly timestamp: number;
  readonly date: string;
  readonly minOfDay: number;
  readonly price: number;
  readonly vwap: number;
  readonly deviationPct: number;
  readonly direction: "above" | "below";
}

interface Outcome {
  readonly deviation: Deviation;
  readonly resolved: boolean;
  readonly resolutionMinutes: number;
  readonly resolutionPrice: number;
  readonly maxAdverseMovePct: number;   // how far it went WRONG before resolving
  readonly maxFavorableMovePct: number; // best gain on the way to resolution
  readonly hitTakeProfit: boolean;       // 0.10% favorable move = +50% on ATM 0DTE
  readonly hitStop: boolean;             // 0.18% adverse move = -50% on premium
}

const DEVIATION_THRESHOLD_PCT = Number(process.env.DEV_THRESHOLD ?? "0.18");
const VWAP_WINDOW_MIN = Number(process.env.VWAP_WINDOW ?? "5");
const HOLD_MAX_MIN = Number(process.env.HOLD_MAX ?? "10");
const TP_FAVORABLE_PCT = Number(process.env.TP_PCT ?? "0.10");
const SL_ADVERSE_PCT = Number(process.env.SL_PCT ?? "0.18");
// Option friction modeled separately for the realism check.
const OPTION_DELTA = Number(process.env.OPT_DELTA ?? "0.50");        // ATM 0DTE
const OPTION_PREMIUM_PCT = Number(process.env.OPT_PREMIUM_PCT ?? "0.0024"); // premium ~ 0.24% of underlying
const SPREAD_COST_PCT = Number(process.env.SPREAD_COST ?? "0.04");   // 4% premium round-trip
const THETA_DRAG_PER_MIN = Number(process.env.THETA_DRAG ?? "0.003"); // 0.3% premium per min near expiry

async function main(): Promise<void> {
  const yahoo = new YahooHistoricalBars();
  const now = Date.now();
  const bars = await yahoo.fetch({
    symbol: "SPY",
    interval: "1m",
    startMs: now - 7 * 24 * 60 * 60 * 1000,
    endMs: now,
    includePrePost: false,
    cache: true,
  });
  process.stdout.write(`Loaded ${bars.length} 1-min bars\n`);

  // Group by day, keep regular-session only (09:30-16:00 ET).
  const byDay = new Map<string, Bar[]>();
  for (const b of bars) {
    const p = etParts(b.timestamp);
    const m = p.hour * 60 + p.minute;
    if (m < 9 * 60 + 30 || m >= 16 * 60) continue;
    if (p.dayOfWeek < 1 || p.dayOfWeek > 5) continue;
    const day = p.date;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(b);
  }

  process.stdout.write(`Trading days: ${byDay.size}\n\n`);

  const allOutcomes: Outcome[] = [];

  for (const [date, dayBars] of Array.from(byDay.entries()).sort()) {
    dayBars.sort((a, b) => a.timestamp - b.timestamp);

    // Compute rolling 5-min VWAP at each bar.
    for (let i = VWAP_WINDOW_MIN; i < dayBars.length; i++) {
      const window = dayBars.slice(i - VWAP_WINDOW_MIN, i);
      const sumPV = window.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume, 0);
      const sumV = window.reduce((s, b) => s + b.volume, 0);
      if (sumV <= 0) continue;
      const vwap = sumPV / sumV;
      const cur = dayBars[i];
      const price = cur.close;
      const deviationPct = ((price - vwap) / vwap) * 100;
      const absDev = Math.abs(deviationPct);
      if (absDev < DEVIATION_THRESHOLD_PCT) continue;

      const dir: "above" | "below" = deviationPct > 0 ? "above" : "below";
      const deviation: Deviation = {
        timestamp: cur.timestamp,
        date,
        minOfDay: etParts(cur.timestamp).hour * 60 + etParts(cur.timestamp).minute,
        price,
        vwap,
        deviationPct,
        direction: dir,
      };

      // Walk forward up to HOLD_MAX_MIN to see if it reverts.
      const forward = dayBars.slice(i + 1, i + 1 + HOLD_MAX_MIN);
      let resolved = false;
      let resolutionMinutes = HOLD_MAX_MIN;
      let resolutionPrice = price;
      let maxAdverse = 0;
      let maxFavorable = 0;
      let hitTP = false;
      let hitSL = false;

      for (let j = 0; j < forward.length; j++) {
        const f = forward[j];
        // Favorable = price moving toward VWAP from current deviation.
        // For "above" deviation, favorable = price dropping.
        const adverseMove = dir === "above"
          ? (f.high - price) / price * 100        // price going further up
          : (price - f.low) / price * 100;        // price going further down
        const favorableMove = dir === "above"
          ? (price - f.low) / price * 100         // price dropping (good for fade)
          : (f.high - price) / price * 100;       // price rising (good for fade)
        if (adverseMove > maxAdverse) maxAdverse = adverseMove;
        if (favorableMove > maxFavorable) maxFavorable = favorableMove;

        if (favorableMove >= TP_FAVORABLE_PCT) {
          resolved = true;
          resolutionMinutes = j + 1;
          resolutionPrice = dir === "above" ? price * (1 - TP_FAVORABLE_PCT / 100) : price * (1 + TP_FAVORABLE_PCT / 100);
          hitTP = true;
          break;
        }
        if (adverseMove >= SL_ADVERSE_PCT) {
          resolved = true;
          resolutionMinutes = j + 1;
          resolutionPrice = dir === "above" ? price * (1 + SL_ADVERSE_PCT / 100) : price * (1 - SL_ADVERSE_PCT / 100);
          hitSL = true;
          break;
        }
      }

      allOutcomes.push({
        deviation,
        resolved,
        resolutionMinutes,
        resolutionPrice,
        maxAdverseMovePct: maxAdverse,
        maxFavorableMovePct: maxFavorable,
        hitTakeProfit: hitTP,
        hitStop: hitSL,
      });
    }
  }

  // Report.
  const total = allOutcomes.length;
  const wins = allOutcomes.filter((o) => o.hitTakeProfit).length;
  const losses = allOutcomes.filter((o) => o.hitStop).length;
  const timeouts = total - wins - losses;
  const avgResMin = allOutcomes.filter((o) => o.resolved).reduce((s, o) => s + o.resolutionMinutes, 0)
    / Math.max(1, allOutcomes.filter((o) => o.resolved).length);

  process.stdout.write("=== Microscalper signal validity (SPY 1-min, 7 days) ===\n");
  process.stdout.write(`Total signals fired:          ${total}\n`);
  process.stdout.write(`Avg signals per trading day:  ${(total / byDay.size).toFixed(1)}\n`);
  process.stdout.write(`Reverted to TP (+0.10%):      ${wins} (${((wins / total) * 100).toFixed(1)}%)\n`);
  process.stdout.write(`Hit adverse SL (+0.18%):      ${losses} (${((losses / total) * 100).toFixed(1)}%)\n`);
  process.stdout.write(`Timeout (no resolution 10m):  ${timeouts} (${((timeouts / total) * 100).toFixed(1)}%)\n`);
  process.stdout.write(`Avg resolution minutes:       ${avgResMin.toFixed(1)}\n`);

  // Simulate the P&L on underlying AND with realistic ATM 0DTE option leverage.
  let cumUnderlyingPct = 0;
  let cumOptionPct = 0;
  let optionWins = 0;
  let optionLosses = 0;
  for (const o of allOutcomes) {
    // Underlying P&L for the trade.
    let underlyingPct: number;
    let holdMinutes: number;
    if (o.hitTakeProfit) { underlyingPct = TP_FAVORABLE_PCT; holdMinutes = o.resolutionMinutes; }
    else if (o.hitStop) { underlyingPct = -SL_ADVERSE_PCT; holdMinutes = o.resolutionMinutes; }
    else {
      underlyingPct = (o.maxFavorableMovePct - o.maxAdverseMovePct) / 2;
      holdMinutes = HOLD_MAX_MIN;
    }
    cumUnderlyingPct += underlyingPct;

    // Option P&L approximation: premium change = delta * (underlying move) / premium
    // - underlying move in % of price -> dollar move = price * pct/100
    // - premium ~ OPTION_PREMIUM_PCT * price
    // - option pct change = delta * dollar_move / premium = (delta * pct) / OPTION_PREMIUM_PCT
    // - subtract spread (round-trip) and theta drag while held.
    const optGrossPct = (OPTION_DELTA * underlyingPct) / (OPTION_PREMIUM_PCT * 100) * 100; // pct change of premium
    const optThetaCost = THETA_DRAG_PER_MIN * 100 * holdMinutes;     // % premium lost to theta
    const optNetPct = optGrossPct - SPREAD_COST_PCT * 100 - optThetaCost;
    cumOptionPct += optNetPct;
    if (optNetPct > 0) optionWins++;
    else optionLosses++;
  }

  process.stdout.write(`\nUnderlying-only sim (no leverage, no fees):\n`);
  process.stdout.write(`  Cumulative pct:   ${cumUnderlyingPct.toFixed(2)}% over ${total} trades\n`);
  process.stdout.write(`  Per-trade EV:     ${(cumUnderlyingPct / total).toFixed(4)}%\n`);

  process.stdout.write(`\nWith ATM 0DTE option leverage + ${(SPREAD_COST_PCT * 100).toFixed(1)}% spread + ${(THETA_DRAG_PER_MIN * 100).toFixed(2)}%/min theta:\n`);
  process.stdout.write(`  Win count:        ${optionWins} (${((optionWins / total) * 100).toFixed(1)}%)\n`);
  process.stdout.write(`  Loss count:       ${optionLosses}\n`);
  process.stdout.write(`  Cumulative pct:   ${cumOptionPct.toFixed(2)}% over ${total} trades (on premium)\n`);
  process.stdout.write(`  Per-trade EV:     ${(cumOptionPct / total).toFixed(2)}% of premium\n`);
  process.stdout.write(`  Assuming 5% bankroll per trade: ${((cumOptionPct / 100) * 5).toFixed(2)}% bankroll over ${total} trades\n`);
  process.stdout.write(`  Daily EV (~${(total / 5).toFixed(1)} trades/day): ${((cumOptionPct / total / 100) * 5 * (total / 5)).toFixed(2)}% bankroll/day\n`);

  // Time-of-day breakdown — when do signals concentrate?
  const buckets = new Map<string, number>();
  for (const o of allOutcomes) {
    const hour = Math.floor(o.deviation.minOfDay / 60);
    const minBucket = Math.floor(o.deviation.minOfDay / 30) * 30;
    const label = `${String(Math.floor(minBucket / 60)).padStart(2, "0")}:${String(minBucket % 60).padStart(2, "0")}`;
    buckets.set(label, (buckets.get(label) ?? 0) + 1);
  }
  process.stdout.write(`\nSignals by 30-min bucket:\n`);
  for (const [label, count] of Array.from(buckets.entries()).sort()) {
    const bar = "#".repeat(Math.round(count / 2));
    process.stdout.write(`  ${label} ${bar} ${count}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
