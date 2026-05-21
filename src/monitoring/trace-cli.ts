// CLI: trace a single signal through every gate in the pipeline.
//
// Usage:
//   npm run trace                                # list all recent signals
//   npm run trace -- --id=<signalId>             # full trace for one signal
//   npm run trace -- --strategy=orb --limit=20   # filter by strategy
//   npm run trace -- --since=2026-05-21T13:00:00Z
//
// Pulls from the JSONL logs the bot writes during operation:
//   data/signals.jsonl              (every signal proposed)
//   data/confluence-decisions.jsonl (every confluence evaluation)
//   data/agent-decisions.jsonl      (every brain decision)
//   data/orders.jsonl               (every order submission)
//   data/positions.jsonl            (every position open)
//   data/outcomes.jsonl             (every position close)
//
// Joins by signalId and prints a coherent timeline so we can verify the
// bot's reasoning on any specific trade.

import { readJsonl } from "../utils/persistence.js";

interface Args {
  signalId: string | null;
  strategy: string | null;
  sinceMs: number;
  limit: number;
}

function parseArgs(): Args {
  const out: Args = { signalId: null, strategy: null, sinceMs: 0, limit: 25 };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--id=")) out.signalId = a.slice("--id=".length);
    else if (a.startsWith("--strategy=")) out.strategy = a.slice("--strategy=".length);
    else if (a.startsWith("--since=")) out.sinceMs = new Date(a.slice("--since=".length)).getTime() || 0;
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
  }
  return out;
}

interface SignalRow {
  readonly ts: string;
  readonly signal: {
    readonly id: string;
    readonly strategy: string;
    readonly timestamp: number;
    readonly description: string;
    readonly riskUsd: number;
    readonly rewardUsd: number;
    readonly stopPrice: number;
    readonly takeProfitPrice: number;
    readonly metadata?: Record<string, unknown>;
  };
  readonly close?: boolean;
}

interface ConfluenceRow {
  readonly ts: string;
  readonly signalId: string;
  readonly direction: string;
  readonly result: {
    readonly passed: boolean;
    readonly score: number;
    readonly nonNeutralCount: number;
    readonly direction: string;
    readonly reasoning: string;
    readonly checks: readonly { name: string; vote: number; confidence: number; detail?: string }[];
  };
}

interface AgentDecisionRow {
  readonly ts: string;
  readonly signal: string;
  readonly decision: {
    readonly go: boolean;
    readonly conviction: number;
    readonly sizeMultiplier: number;
    readonly reasoning: string;
  };
}

interface OrderRow {
  readonly ts: string;
  readonly mode: string;
  readonly flow: string;
  readonly broker?: string;
  readonly signalId?: string;
  readonly orderId?: string;
  readonly signal?: { id: string };
}

interface PositionRow {
  readonly ts: string;
  readonly event: string;
  readonly key: string;
  readonly position: {
    readonly entryPrice: number;
    readonly quantity: number;
    readonly side: string;
    readonly strategy: string;
    readonly metadata?: { signalId?: string };
  };
}

interface OutcomeRow {
  readonly ts: string;
  readonly key: string;
  readonly strategy: string;
  readonly side: string;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly pnl: number;
  readonly holdMs: number;
  readonly metadata?: { signalId?: string; closeReason?: string };
}

function main(): void {
  const args = parseArgs();

  const signals = readJsonl<SignalRow>("data/signals.jsonl");
  const confluence = readJsonl<ConfluenceRow>("data/confluence-decisions.jsonl");
  const decisions = readJsonl<AgentDecisionRow>("data/agent-decisions.jsonl");
  const orders = readJsonl<OrderRow>("data/orders.jsonl");
  const positions = readJsonl<PositionRow>("data/positions.jsonl");
  const outcomes = readJsonl<OutcomeRow>("data/outcomes.jsonl");

  // Either trace one signal in detail, or list recent signals.
  if (args.signalId) {
    traceOne(args.signalId, signals, confluence, decisions, orders, positions, outcomes);
    return;
  }

  // List recent signals filtered by strategy and since-time.
  const filtered = signals
    .filter((s) => !args.strategy || s.signal.strategy === args.strategy)
    .filter((s) => !args.sinceMs || new Date(s.ts).getTime() >= args.sinceMs)
    .slice(-args.limit);

  process.stdout.write(`\nRecent signals (${filtered.length} of ${signals.length} total):\n`);
  for (const s of filtered) {
    const sig = s.signal;
    const conf = confluence.find((c) => c.signalId === sig.id);
    const dec = decisions.find((d) => d.signal === sig.id);
    const order = orders.find((o) => (o.signalId === sig.id || o.signal?.id === sig.id) && o.flow !== "close");
    const pos = positions.find((p) => p.position?.metadata?.signalId === sig.id);
    const outcome = outcomes.find((o) => o.metadata?.signalId === sig.id);

    const status = outcome
      ? `CLOSED ${outcome.pnl >= 0 ? "+" : ""}$${outcome.pnl.toFixed(2)}`
      : pos
        ? `OPEN @ $${pos.position.entryPrice.toFixed(2)}`
        : order && order.mode === "live"
          ? `SUBMITTED ${order.orderId ?? ""}`
          : conf && !conf.result.passed
            ? `REJECTED (confluence)`
            : dec && !dec.decision.go
              ? `REJECTED (brain: ${dec.decision.reasoning})`
              : `INFLIGHT`;
    process.stdout.write(`  ${s.ts}  ${sig.id}  ${sig.strategy}  ${status}\n`);
    process.stdout.write(`    ${sig.description}\n`);
  }
  process.stdout.write(`\nRun with --id=<signalId> for full per-signal trace.\n`);
}

function traceOne(
  signalId: string,
  signals: readonly SignalRow[],
  confluence: readonly ConfluenceRow[],
  decisions: readonly AgentDecisionRow[],
  orders: readonly OrderRow[],
  positions: readonly PositionRow[],
  outcomes: readonly OutcomeRow[],
): void {
  const signal = signals.find((s) => s.signal.id === signalId);
  if (!signal) {
    process.stderr.write(`No signal with id ${signalId} found.\n`);
    process.exit(1);
  }
  const sig = signal.signal;
  process.stdout.write(`\n===== Trace: ${signalId} =====\n`);
  process.stdout.write(`Time:        ${signal.ts}\n`);
  process.stdout.write(`Strategy:    ${sig.strategy}\n`);
  process.stdout.write(`Description: ${sig.description}\n`);
  process.stdout.write(`Risk:        $${sig.riskUsd.toFixed(2)} / Reward target: $${sig.rewardUsd.toFixed(2)}\n`);
  process.stdout.write(`Stop:        ${sig.stopPrice.toFixed(2)} / Take: ${sig.takeProfitPrice.toFixed(2)}\n`);
  if (sig.metadata) {
    process.stdout.write(`Metadata:    ${JSON.stringify(sig.metadata)}\n`);
  }

  const conf = confluence.find((c) => c.signalId === signalId);
  if (conf) {
    process.stdout.write(`\n--- Confluence ---\n`);
    process.stdout.write(`  Passed: ${conf.result.passed}  Score: ${conf.result.score.toFixed(2)}\n`);
    process.stdout.write(`  Reasoning: ${conf.result.reasoning}\n`);
    for (const ck of conf.result.checks) {
      process.stdout.write(`    ${ck.name.padEnd(18)} vote=${ck.vote.toFixed(2).padStart(6)}  conf=${ck.confidence.toFixed(2)}  ${ck.detail ?? ""}\n`);
    }
  } else {
    process.stdout.write(`\n--- Confluence ---\n  (no record)\n`);
  }

  const dec = decisions.find((d) => d.signal === signalId);
  if (dec) {
    process.stdout.write(`\n--- Agent Brain ---\n`);
    process.stdout.write(`  Go: ${dec.decision.go}  Conviction: ${dec.decision.conviction}  Size mul: ${dec.decision.sizeMultiplier.toFixed(2)}\n`);
    process.stdout.write(`  Reasoning: ${dec.decision.reasoning}\n`);
  } else {
    process.stdout.write(`\n--- Agent Brain ---\n  (no record — brain disabled or skipped via fast lane)\n`);
  }

  const order = orders.find((o) => (o.signalId === signalId || o.signal?.id === signalId) && o.flow !== "close");
  if (order) {
    process.stdout.write(`\n--- Order ---\n`);
    process.stdout.write(`  Mode: ${order.mode}  Flow: ${order.flow}  Broker: ${order.broker ?? "n/a"}  OrderId: ${order.orderId ?? "n/a"}\n`);
  } else {
    process.stdout.write(`\n--- Order ---\n  (no order submitted; signal was rejected before dispatch)\n`);
  }

  const pos = positions.find((p) => p.position?.metadata?.signalId === signalId);
  if (pos) {
    process.stdout.write(`\n--- Position open ---\n`);
    process.stdout.write(`  Key: ${pos.key}  Side: ${pos.position.side}  Qty: ${pos.position.quantity}\n`);
    process.stdout.write(`  Entry: $${pos.position.entryPrice.toFixed(2)}\n`);
  }

  const outcome = outcomes.find((o) => o.metadata?.signalId === signalId);
  if (outcome) {
    process.stdout.write(`\n--- Outcome ---\n`);
    process.stdout.write(`  Exit: $${outcome.exitPrice.toFixed(2)}\n`);
    process.stdout.write(`  P&L: ${outcome.pnl >= 0 ? "+" : ""}$${outcome.pnl.toFixed(2)}\n`);
    process.stdout.write(`  Hold: ${(outcome.holdMs / 1000).toFixed(0)}s\n`);
    if (outcome.metadata?.closeReason) {
      process.stdout.write(`  Close reason: ${outcome.metadata.closeReason}\n`);
    }
  }

  // Any later close orders or activity tied to the same instrument.
  const closeOrders = orders.filter((o) => o.flow === "close" && (o.signalId === signalId || o.signal?.id?.startsWith(`close-`)));
  if (closeOrders.length > 0) {
    process.stdout.write(`\n--- Close orders ---\n`);
    for (const co of closeOrders) {
      process.stdout.write(`  ${co.ts}  ${co.mode}  orderId=${co.orderId ?? "n/a"}\n`);
    }
  }
}

main();
