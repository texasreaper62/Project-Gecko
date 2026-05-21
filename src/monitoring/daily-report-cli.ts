// CLI: daily P&L attribution report.
//
// Aggregates outcomes from data/outcomes.jsonl and produces a breakdown
// that lets you see exactly where the bot's edge (or lack of edge) is
// coming from. Tracks attribution by:
//   - Strategy (ORB vs mean-reversion vs pairs vs earnings)
//   - Direction (LONG vs SHORT)
//   - Brain conviction tier (60-69, 70-79, 80-89, 90+)
//   - Time of day
//   - Day of week
//   - Hold duration
//   - Symbol
//   - Regime (when available)
//
// This is what professional shops have and retail rarely does.
// Run after every trading session to see what's actually driving P&L.
//
// Usage:
//   npm run report                       # full lifetime
//   npm run report -- --since=2026-05-01 # since a date
//   npm run report -- --days=7           # last N days

import { readJsonl } from "../utils/persistence.js";
import { etParts } from "../utils/time.js";

interface OutcomeRow {
  readonly ts: string;
  readonly key: string;
  readonly strategy: string;
  readonly side: "LONG" | "SHORT";
  readonly qty: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly pnl: number;
  readonly holdMs: number;
  readonly metadata?: {
    readonly brainConviction?: number;
    readonly finalRiskPct?: number;
    readonly regime?: string;
    readonly gapPct?: number;
    readonly orWidthPct?: number;
    readonly closeReason?: string;
    readonly stopTrailed?: boolean;
  };
}

interface Args {
  sinceMs: number;
  days: number | null;
}

function parseArgs(): Args {
  const out: Args = { sinceMs: 0, days: null };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--since=")) out.sinceMs = new Date(a.slice("--since=".length)).getTime() || 0;
    else if (a.startsWith("--days=")) out.days = Number(a.slice("--days=".length));
  }
  if (out.days !== null && out.sinceMs === 0) {
    out.sinceMs = Date.now() - out.days * 24 * 60 * 60 * 1000;
  }
  return out;
}

function fmtPct(n: number): string { return (n * 100).toFixed(1) + "%"; }
function fmtMoney(n: number): string { return (n >= 0 ? "+" : "") + "$" + n.toFixed(2); }
function pad(s: string, w: number): string { return s.padEnd(w); }

function bucketize<T>(outs: readonly OutcomeRow[], by: (o: OutcomeRow) => string | null): Map<string, OutcomeRow[]> {
  const m = new Map<string, OutcomeRow[]>();
  for (const o of outs) {
    const k = by(o);
    if (k === null) continue;
    const arr = m.get(k) ?? [];
    arr.push(o);
    m.set(k, arr);
  }
  return m;
}

function summarize(outs: readonly OutcomeRow[]): { n: number; wins: number; winRate: number; pnl: number; pf: number; avgWin: number; avgLoss: number } {
  const wins = outs.filter((o) => o.pnl > 0);
  const losses = outs.filter((o) => o.pnl < 0);
  const wPnl = wins.reduce((s, o) => s + o.pnl, 0);
  const lPnl = losses.reduce((s, o) => s + o.pnl, 0);
  const tot = outs.length;
  return {
    n: tot,
    wins: wins.length,
    winRate: tot > 0 ? wins.length / tot : 0,
    pnl: wPnl + lPnl,
    pf: lPnl !== 0 ? wPnl / Math.abs(lPnl) : (wPnl > 0 ? Infinity : 0),
    avgWin: wins.length > 0 ? wPnl / wins.length : 0,
    avgLoss: losses.length > 0 ? lPnl / losses.length : 0,
  };
}

function printBucketed(label: string, buckets: Map<string, OutcomeRow[]>): void {
  process.stdout.write(`\n=== ${label} ===\n`);
  process.stdout.write(`  ${pad("Bucket", 20)} ${pad("N", 4)} ${pad("Win%", 7)} ${pad("PF", 7)} ${pad("Net", 10)} ${pad("AvgW", 10)} ${pad("AvgL", 10)}\n`);
  const rows = [...buckets.entries()].sort((a, b) => summarize(b[1]).pnl - summarize(a[1]).pnl);
  for (const [k, outs] of rows) {
    const s = summarize(outs);
    const pfStr = s.pf === Infinity ? "inf" : s.pf.toFixed(2);
    process.stdout.write(
      `  ${pad(k, 20)} ${pad(String(s.n), 4)} ${pad(fmtPct(s.winRate), 7)} ${pad(pfStr, 7)} ${pad(fmtMoney(s.pnl), 10)} ${pad(fmtMoney(s.avgWin), 10)} ${pad(fmtMoney(s.avgLoss), 10)}\n`,
    );
  }
}

function convictionTier(c: number | undefined): string {
  if (c === undefined || c === null) return "no-brain";
  if (c >= 90) return "90+";
  if (c >= 80) return "80-89";
  if (c >= 70) return "70-79";
  if (c >= 60) return "60-69";
  return "<60";
}

function holdBucket(ms: number): string {
  if (ms === 0) return "instant";
  const min = ms / 60_000;
  if (min < 5) return "0-5m";
  if (min < 15) return "5-15m";
  if (min < 30) return "15-30m";
  if (min < 60) return "30-60m";
  if (min < 120) return "1-2h";
  return "2h+";
}

function main(): void {
  const args = parseArgs();
  let outs = readJsonl<OutcomeRow>("data/outcomes.jsonl");
  if (args.sinceMs > 0) {
    outs = outs.filter((o) => new Date(o.ts).getTime() >= args.sinceMs);
  }

  if (outs.length === 0) {
    process.stdout.write("No outcomes in window.\n");
    return;
  }

  // Overall
  const s = summarize(outs);
  process.stdout.write("===== Lifetime Summary =====\n");
  process.stdout.write(`  Trades:        ${s.n}\n`);
  process.stdout.write(`  Win rate:      ${fmtPct(s.winRate)} (${s.wins}W / ${s.n - s.wins}L)\n`);
  process.stdout.write(`  Total P&L:     ${fmtMoney(s.pnl)}\n`);
  process.stdout.write(`  Profit factor: ${s.pf === Infinity ? "inf" : s.pf.toFixed(2)}\n`);
  process.stdout.write(`  Avg win:       ${fmtMoney(s.avgWin)}\n`);
  process.stdout.write(`  Avg loss:      ${fmtMoney(s.avgLoss)}\n`);

  // By strategy
  printBucketed("By strategy", bucketize(outs, (o) => o.strategy));
  // By direction
  printBucketed("By direction", bucketize(outs, (o) => o.side));
  // By brain conviction tier
  printBucketed("By brain conviction", bucketize(outs, (o) => convictionTier(o.metadata?.brainConviction)));
  // By symbol
  printBucketed("By symbol", bucketize(outs, (o) => o.key.replace(/^EQ:|^OPT:/, "")));
  // By hour-of-day (ET)
  printBucketed("By hour-of-day (ET)", bucketize(outs, (o) => {
    const ts = new Date(o.ts).getTime();
    const p = etParts(ts);
    return String(p.hour).padStart(2, "0") + ":00";
  }));
  // By day-of-week
  printBucketed("By day-of-week", bucketize(outs, (o) => {
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return dow[etParts(new Date(o.ts).getTime()).dayOfWeek];
  }));
  // By hold duration
  printBucketed("By hold duration", bucketize(outs, (o) => holdBucket(o.holdMs)));
  // By regime (when set)
  printBucketed("By regime", bucketize(outs, (o) => o.metadata?.regime ?? "no-regime"));
  // Trailed vs not
  printBucketed("By trail status", bucketize(outs, (o) => o.metadata?.stopTrailed === true ? "trailed" : "not-trailed"));

  // Top 5 winners and losers
  const sorted = [...outs].sort((a, b) => b.pnl - a.pnl);
  process.stdout.write("\n=== Top 5 winners ===\n");
  for (const o of sorted.slice(0, 5)) {
    process.stdout.write(`  ${o.ts.slice(0, 10)}  ${o.strategy}  ${o.side} ${o.key}  ${fmtMoney(o.pnl)}\n`);
  }
  process.stdout.write("\n=== Top 5 losers ===\n");
  for (const o of sorted.slice(-5).reverse()) {
    process.stdout.write(`  ${o.ts.slice(0, 10)}  ${o.strategy}  ${o.side} ${o.key}  ${fmtMoney(o.pnl)}\n`);
  }
}

main();
