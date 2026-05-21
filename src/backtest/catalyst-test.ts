// Hypothesis tests for the catalyst-trading plan.
//
// Claims being tested:
//   1. NFP/CPI release days produce predictable, tradable SPY moves
//      (claim: 0.5-1.5% in the first 15 min after 8:30 ET)
//   2. 0DTE ATM options can return 200-400% on a 1-2% SPY move
//   3. The release-day move size is meaningfully larger than non-release days
//
// Method:
//   - Pull SPY 5-min bars with pre-market over the last 60 days
//   - For every trading day, find the 8:30 ET bar (= NFP/CPI release time)
//   - Compute the % move from 8:30 to 8:45 (15 min) and 8:30 to 9:00 (30 min)
//   - Rank days by move size; cross-reference with known release dates
//   - Use Black-Scholes to simulate 0DTE ATM option returns on those moves

import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import { etParts } from "../utils/time.js";
import type { Bar } from "../core/types.js";

interface DayMove {
  readonly date: string;
  readonly dayOfWeek: number;
  readonly bar830: Bar | null;
  readonly bar845: Bar | null;
  readonly bar900: Bar | null;
  readonly bar930: Bar | null;
  readonly bar1000: Bar | null;
  readonly move15: number;          // 8:30 -> 8:45 %
  readonly move30: number;          // 8:30 -> 9:00 %
  readonly move60: number;          // 8:30 -> 9:30 %
  readonly fullMorning: number;     // 8:30 -> 10:00 %
}

async function main(): Promise<void> {
  const yahoo = new YahooHistoricalBars();
  const now = Date.now();
  const bars = await yahoo.fetch({
    symbol: "SPY",
    interval: "5m",
    startMs: now - 60 * 24 * 60 * 60 * 1000,
    endMs: now,
    includePrePost: true,
    cache: false,           // force fresh to capture pre-market
  });
  process.stdout.write(`Loaded ${bars.length} 5-min SPY bars\n`);

  // Group by ET date.
  const byDay = new Map<string, Bar[]>();
  for (const b of bars) {
    const p = etParts(b.timestamp);
    if (p.dayOfWeek < 1 || p.dayOfWeek > 5) continue;
    const day = p.date;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(b);
  }

  process.stdout.write(`Trading days: ${byDay.size}\n\n`);

  const moves: DayMove[] = [];
  for (const [date, dayBars] of byDay) {
    dayBars.sort((a, b) => a.timestamp - b.timestamp);
    const findBar = (h: number, m: number): Bar | null => {
      const target = h * 60 + m;
      return dayBars.find((b) => {
        const p = etParts(b.timestamp);
        return p.hour * 60 + p.minute === target;
      }) ?? null;
    };

    const b830 = findBar(8, 30);
    const b845 = findBar(8, 45);
    const b900 = findBar(9, 0);
    const b930 = findBar(9, 30);
    const b1000 = findBar(10, 0);

    if (!b830) continue;

    const move15 = b845 ? ((b845.close - b830.close) / b830.close) * 100 : NaN;
    const move30 = b900 ? ((b900.close - b830.close) / b830.close) * 100 : NaN;
    const move60 = b930 ? ((b930.close - b830.close) / b830.close) * 100 : NaN;
    const fullMorning = b1000 ? ((b1000.close - b830.close) / b830.close) * 100 : NaN;

    const p = etParts(b830.timestamp);
    moves.push({
      date,
      dayOfWeek: p.dayOfWeek,
      bar830: b830,
      bar845: b845,
      bar900: b900,
      bar930: b930,
      bar1000: b1000,
      move15, move30, move60, fullMorning,
    });
  }

  // Sort by absolute 30-min move; the biggest are likely catalyst days.
  const sorted = [...moves].sort((a, b) => Math.abs(b.move30) - Math.abs(a.move30));

  process.stdout.write("=== Top 15 biggest 8:30->9:00 ET moves (last 60 days) ===\n");
  process.stdout.write("Date        DOW  |8:30->8:45| |8:30->9:00| |8:30->9:30| |8:30->10:00|\n");
  for (const m of sorted.slice(0, 15)) {
    const dowName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][m.dayOfWeek];
    process.stdout.write(
      `${m.date} ${dowName} ${pad(m.move15, 12)} ${pad(m.move30, 12)} ${pad(m.move60, 12)} ${pad(m.fullMorning, 13)}\n`
    );
  }

  // Compute baseline: what's the average and median absolute morning move on
  // any random trading day, for context?
  const valid30 = moves.filter((m) => Number.isFinite(m.move30));
  const abs30 = valid30.map((m) => Math.abs(m.move30)).sort((a, b) => a - b);
  const median = abs30[Math.floor(abs30.length / 2)] ?? 0;
  const mean = abs30.reduce((s, v) => s + v, 0) / Math.max(1, abs30.length);
  const p90 = abs30[Math.floor(abs30.length * 0.90)] ?? 0;
  const p95 = abs30[Math.floor(abs30.length * 0.95)] ?? 0;

  process.stdout.write(`\n=== Baseline: |8:30 -> 9:00| moves across ${valid30.length} days ===\n`);
  process.stdout.write(`Median:  ${median.toFixed(3)}%\n`);
  process.stdout.write(`Mean:    ${mean.toFixed(3)}%\n`);
  process.stdout.write(`90th p:  ${p90.toFixed(3)}%\n`);
  process.stdout.write(`95th p:  ${p95.toFixed(3)}%\n`);

  // Black-Scholes 0DTE option pricing for the option-leg claim.
  process.stdout.write(`\n=== 0DTE ATM option return simulator (Black-Scholes) ===\n`);
  process.stdout.write(`Assumed: SPY=$740, IV=15%, r=4%, time-to-expiry varies\n\n`);
  const spy = 740;
  const iv = 0.15;
  const r = 0.04;

  // ATM option price at given hours-to-expiry.
  const hoursOpen = 6.5;     // full day
  const hoursAfter = 6.5 - 1;     // 1 hour into session (post-NFP entry)
  const hoursExit = 6.5 - 1.5;    // 30 min later exit

  process.stdout.write(`Underlying move    | Premium @ entry | Premium @ exit | Return\n`);
  for (const move of [0.3, 0.5, 0.7, 1.0, 1.5, 2.0]) {
    const k = spy;                              // ATM
    const sBeforeMove = spy;
    const sAfterMove = spy * (1 + move / 100);

    // Black-Scholes for a call at entry (before move) with hoursAfter remaining
    const tEntry = hoursAfter / (6.5 * 252);   // years
    const tExit = hoursExit / (6.5 * 252);

    const cEntry = blackScholesCall(sBeforeMove, k, tEntry, r, iv);
    const cExit = blackScholesCall(sAfterMove, k, tExit, r, iv);
    const retPct = ((cExit - cEntry) / cEntry) * 100;
    process.stdout.write(
      `   ${pad(move, 4)}% up      | $${pad(cEntry, 5, 2)}         | $${pad(cExit, 5, 2)}        | ${pad(retPct, 6, 1)}%\n`
    );
  }

  // With 4¢ bid-ask spread on the option (typical for ATM 0DTE SPY).
  process.stdout.write(`\nWith 4 cent bid-ask spread (more realistic):\n`);
  process.stdout.write(`Underlying move    | Entry @ ask     | Exit @ bid     | Return\n`);
  const spreadHalf = 0.02;
  for (const move of [0.3, 0.5, 0.7, 1.0, 1.5, 2.0]) {
    const k = spy;
    const sBeforeMove = spy;
    const sAfterMove = spy * (1 + move / 100);
    const tEntry = hoursAfter / (6.5 * 252);
    const tExit = hoursExit / (6.5 * 252);
    const cMidEntry = blackScholesCall(sBeforeMove, k, tEntry, r, iv);
    const cMidExit = blackScholesCall(sAfterMove, k, tExit, r, iv);
    const cAtAsk = cMidEntry + spreadHalf;       // pay ask on entry
    const cAtBid = Math.max(0, cMidExit - spreadHalf);  // sell at bid on exit
    const retPct = ((cAtBid - cAtAsk) / cAtAsk) * 100;
    process.stdout.write(
      `   ${pad(move, 4)}% up      | $${pad(cAtAsk, 5, 2)}         | $${pad(cAtBid, 5, 2)}        | ${pad(retPct, 6, 1)}%\n`
    );
  }

  // Stop scenarios (move went WRONG direction).
  process.stdout.write(`\nAdverse moves (option goes against us):\n`);
  process.stdout.write(`Underlying move    | Entry          | Exit           | Return\n`);
  for (const move of [-0.3, -0.5, -1.0, -1.5]) {
    const k = spy;
    const sBeforeMove = spy;
    const sAfterMove = spy * (1 + move / 100);
    const tEntry = hoursAfter / (6.5 * 252);
    const tExit = hoursExit / (6.5 * 252);
    const cMidEntry = blackScholesCall(sBeforeMove, k, tEntry, r, iv);
    const cMidExit = blackScholesCall(sAfterMove, k, tExit, r, iv);
    const cAtAsk = cMidEntry + spreadHalf;
    const cAtBid = Math.max(0, cMidExit - spreadHalf);
    const retPct = ((cAtBid - cAtAsk) / cAtAsk) * 100;
    process.stdout.write(
      `   ${pad(move, 4)}% down    | $${pad(cAtAsk, 5, 2)}         | $${pad(cAtBid, 5, 2)}        | ${pad(retPct, 6, 1)}%\n`
    );
  }
}

function blackScholesCall(s: number, k: number, t: number, r: number, sigma: number): number {
  if (t <= 0) return Math.max(0, s - k);
  const d1 = (Math.log(s / k) + (r + 0.5 * sigma * sigma) * t) / (sigma * Math.sqrt(t));
  const d2 = d1 - sigma * Math.sqrt(t);
  return s * normCdf(d1) - k * Math.exp(-r * t) * normCdf(d2);
}

function normCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function pad(n: number, width: number, dec = 2): string {
  if (!Number.isFinite(n)) return "n/a".padStart(width);
  return n.toFixed(dec).padStart(width);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
