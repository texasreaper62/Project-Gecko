// AgentBrain: live AI decision layer that gates every trade.
//
// Strategies emit candidate signals (rules-based: ORB, Engine B, etc).
// Before the signal goes to the order router, AgentBrain asks Claude to
// validate it with full market context:
//   - Setup details (instrument, direction, entry, stop, target, R-multiple)
//   - Recent price action (last N bars)
//   - Current market regime (VIX, breadth, time of day)
//   - Open positions and today's running P&L
//   - Recent outcomes (last 20 trades — what's been working)
//
// Claude returns:
//   - conviction: 0-100
//   - go: true/false
//   - sizeMultiplier: 0.25-2.0 (scale the strategy's default size)
//   - reasoning: one-line rationale
//   - revisedStop/revisedTake: optional overrides
//
// Trades only fire if conviction >= AGENT_MIN_CONVICTION (default 70).
// The override lets the brain push back on bad setups OR amplify good ones.

import { createLogger } from "../core/logger.js";
import { appendJsonl, readJsonl } from "../utils/persistence.js";
import { nowIso } from "../utils/time.js";
import type { TradeSignal, AccountSnapshot, Position } from "../core/types.js";

const log = createLogger("agent-brain");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DECISION_TIMEOUT_MS = 20_000;
const DECISIONS_LOG = "data/agent-decisions.jsonl";
const OUTCOMES_LOG = "data/outcomes.jsonl";

export interface AgentBrainConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly minConviction: number;          // default 70 — base threshold
  readonly minConvictionLong?: number;     // override for LONG trades
  readonly minConvictionShort?: number;    // override for SHORT trades
}

export interface MarketContext {
  readonly vixLevel?: number;
  readonly spyChangePct?: number;
  readonly timeOfDayEt: string;            // "HH:MM"
  readonly dayOfWeek: string;              // "Mon"..."Fri"
  readonly recentBars?: ReadonlyArray<{    // last 5-10 bars on the instrument
    readonly t: string;
    readonly o: number; readonly h: number; readonly l: number; readonly c: number; readonly v: number;
  }>;
  readonly recentHeadlines?: readonly string[];     // last 3-5 news items if available
}

export interface AgentDecision {
  readonly go: boolean;
  readonly conviction: number;              // 0-100
  readonly sizeMultiplier: number;          // 0.25-2.0
  readonly revisedStop?: number;
  readonly revisedTake?: number;
  readonly reasoning: string;
}

interface RecentOutcome {
  readonly strategy: string;
  readonly pnl: number;
  readonly rMultiple?: number;
}

export class AgentBrain {
  // Concurrency limiter. Anthropic's lower tiers cap concurrent connections
  // and have a 50 req/min ceiling. We serialize brain calls to ~4 in flight
  // so bursts don't trigger HTTP 429.
  private static readonly MAX_CONCURRENT = 4;
  private inFlight = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly config: AgentBrainConfig) {}

  isEnabled(): boolean {
    return this.config.enabled && this.config.apiKey.length > 0;
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < AgentBrain.MAX_CONCURRENT) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.inFlight++;
  }
  private release(): void {
    this.inFlight--;
    const next = this.queue.shift();
    if (next) {
      // Re-acquire happens after we resolve their wait — they take our slot.
      this.inFlight--;
      next();
    }
  }

  // Validate a signal. Returns the approved (and possibly modified) signal,
  // or null if the brain says no-go.
  async decide(
    signal: TradeSignal,
    account: AccountSnapshot,
    openPositions: readonly Position[],
    context: MarketContext,
  ): Promise<{ approved: TradeSignal | null; decision: AgentDecision }> {
    if (!this.isEnabled()) {
      // Bypass: act as a no-op, approving the signal as-is.
      return { approved: signal, decision: passThrough() };
    }

    const recent = this.loadRecentOutcomes(20);
    const worstOutcomes = this.loadWorstOutcomes(5);
    const prompt = buildPrompt(signal, account, openPositions, context, recent, worstOutcomes);

    let decision: AgentDecision;
    try {
      decision = await this.callClaude(prompt);
    } catch (err) {
      log.error("AgentBrain call failed; rejecting signal for safety", {
        signalId: signal.id,
        error: err instanceof Error ? err.message : String(err),
      });
      const rej: AgentDecision = {
        go: false, conviction: 0, sizeMultiplier: 0,
        reasoning: "brain call failed",
      };
      appendJsonl(DECISIONS_LOG, { ts: nowIso(), signal: signal.id, decision: rej, error: true });
      return { approved: null, decision: rej };
    }

    appendJsonl(DECISIONS_LOG, { ts: nowIso(), signal: signal.id, decision });

    // Asymmetric thresholds: shadow data showed longs 83% / shorts 50% win
    // rate. Apply stricter conviction floor on shorts.
    const isLong = signal.order.side === "BUY" || signal.order.side === "BUY_TO_OPEN";
    const threshold = isLong
      ? (this.config.minConvictionLong ?? this.config.minConviction)
      : (this.config.minConvictionShort ?? this.config.minConviction);

    if (!decision.go || decision.conviction < threshold) {
      log.info("AgentBrain rejected signal", {
        signalId: signal.id,
        conviction: decision.conviction,
        threshold,
        direction: isLong ? "LONG" : "SHORT",
        reason: decision.reasoning,
      });
      return { approved: null, decision };
    }

    // Apply approved modifications.
    const baseQty = signal.order.quantity;
    const scaledQty = Math.max(1, Math.round(baseQty * decision.sizeMultiplier));
    const approved: TradeSignal = {
      ...signal,
      order: { ...signal.order, quantity: scaledQty },
      stopPrice: decision.revisedStop ?? signal.stopPrice,
      takeProfitPrice: decision.revisedTake ?? signal.takeProfitPrice,
      metadata: {
        ...signal.metadata,
        brainConviction: decision.conviction,
        brainSizeMul: decision.sizeMultiplier,
        brainReasoning: decision.reasoning,
      },
    };

    log.info("AgentBrain approved signal", {
      signalId: signal.id,
      conviction: decision.conviction,
      sizeMul: decision.sizeMultiplier,
      qtyOriginal: baseQty,
      qtyApproved: scaledQty,
    });
    return { approved, decision };
  }

  // Specifically loads the WORST recent outcomes so the brain learns from
  // its mistakes. These are fed in alongside the rolling-window stats so
  // the brain has concrete "do not repeat" examples in its context.
  private loadWorstOutcomes(n: number): readonly { strategy: string; pnl: number; side: string; key: string; reasoning: string; conviction: number }[] {
    try {
      const all = readJsonl<{ strategy: string; pnl: number; side: string; key: string; metadata?: { brainConviction?: number; brainReasoning?: string } }>(OUTCOMES_LOG);
      const losers = all.filter((o) => o.pnl < 0)
        .sort((a, b) => a.pnl - b.pnl)
        .slice(0, n);
      return losers.map((o) => ({
        strategy: o.strategy,
        pnl: o.pnl,
        side: o.side,
        key: o.key,
        reasoning: o.metadata?.brainReasoning ?? "",
        conviction: o.metadata?.brainConviction ?? 0,
      }));
    } catch {
      return [];
    }
  }

  private loadRecentOutcomes(n: number): RecentOutcome[] {
    try {
      const all = readJsonl<{ strategy: string; pnl: number; metadata?: { riskUsd?: number } }>(OUTCOMES_LOG);
      const slice = all.slice(-n);
      return slice.map((o) => ({
        strategy: o.strategy,
        pnl: o.pnl,
        rMultiple: o.metadata?.riskUsd ? o.pnl / o.metadata.riskUsd : undefined,
      }));
    } catch {
      return [];
    }
  }

  private async callClaude(prompt: string): Promise<AgentDecision> {
    await this.acquire();
    try {
      return await this.callClaudeInner(prompt);
    } finally {
      this.release();
    }
  }

  private async callClaudeInner(prompt: string): Promise<AgentDecision> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DECISION_TIMEOUT_MS);

    // Split prompt into a fixed system prefix (cacheable) and a variable user
    // portion. Anthropic's prompt cache cuts repeated-prefix latency ~40-50%
    // and cost ~90%. The system prefix is the role + decision rubric, which
    // doesn't change per trade. The user message is the trade-specific data.
    const userBlockStart = prompt.indexOf("=== PROPOSED TRADE ===");
    const systemPrefix = userBlockStart > 0
      ? prompt.slice(0, userBlockStart).trim()
      : SYSTEM_PREFIX_FALLBACK;
    const userBody = userBlockStart > 0 ? prompt.slice(userBlockStart) : prompt;

    let resp: Response;
    try {
      resp = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": this.config.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 500,
          system: [
            { type: "text", text: systemPrefix, cache_control: { type: "ephemeral" } },
          ],
          messages: [
            { role: "user", content: userBody + "\n\nRespond with ONLY the JSON object, no preamble, no commentary, no markdown fences. Start your response with { and end with }." },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Anthropic HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    const json = await resp.json() as { content?: { type: string; text: string }[]; error?: { message: string }; usage?: import("./anthropic-cost-tracker.js").AnthropicUsage };
    if (json.error) throw new Error(`Anthropic error: ${json.error.message}`);
    // Track spend.
    const { costTracker } = await import("./anthropic-cost-tracker.js");
    costTracker.record("agent-brain", this.config.model, json.usage);
    const text = json.content?.find((c) => c.type === "text")?.text ?? "";
    return parseDecision(text);
  }
}

function buildPrompt(
  signal: TradeSignal,
  account: AccountSnapshot,
  open: readonly Position[],
  ctx: MarketContext,
  recent: readonly RecentOutcome[],
  worst: readonly { strategy: string; pnl: number; side: string; key: string; reasoning: string; conviction: number }[],
): string {
  const recentWins = recent.filter((r) => r.pnl > 0).length;
  const recentTotal = recent.length;
  const recentPnl = recent.reduce((s, r) => s + r.pnl, 0);

  // The static rubric lives in the system block (cached). Here we only emit
  // the variable per-trade data, prefixed with the marker that callClaude
  // uses to split system vs user portions.
  return [
    `=== PROPOSED TRADE ===`,
    `Strategy: ${signal.strategy}`,
    `Description: ${signal.description}`,
    `Instrument: ${signal.order.instrument.assetClass === "equity"
      ? `EQUITY ${signal.order.instrument.symbol}`
      : `OPTION ${signal.order.instrument.osiSymbol} (${signal.order.instrument.optionType} ${signal.order.instrument.strike} exp ${signal.order.instrument.expiration})`}`,
    `Side: ${signal.order.side}`,
    `Quantity (base): ${signal.order.quantity}`,
    `Limit price: ${signal.order.limitPrice ?? "n/a"}`,
    `Stop: ${signal.stopPrice}`,
    `Take profit: ${signal.takeProfitPrice}`,
    `Risk: $${signal.riskUsd.toFixed(2)}`,
    `Reward target: $${signal.rewardUsd.toFixed(2)}`,
    `R:R = ${(signal.rewardUsd / Math.max(0.01, signal.riskUsd)).toFixed(2)}:1`,
    `Strategy metadata: ${JSON.stringify(signal.metadata)}`,
    ``,
    `=== ACCOUNT ===`,
    `Equity: $${account.equity.toFixed(2)}`,
    `Cash: $${account.cashBalance.toFixed(2)}`,
    `Day-trade BP: $${account.dayTradeBuyingPower.toFixed(2)}`,
    `Day-trade count: ${account.dayTradeCount}`,
    `Open positions: ${open.length} (${open.map((p) => `${p.strategy}:${p.side}`).join(", ") || "none"})`,
    ``,
    `=== MARKET CONTEXT ===`,
    `Time (ET): ${ctx.timeOfDayEt} ${ctx.dayOfWeek}`,
    ctx.vixLevel !== undefined ? `VIX: ${ctx.vixLevel.toFixed(2)}` : "",
    ctx.spyChangePct !== undefined ? `SPY change today: ${ctx.spyChangePct.toFixed(2)}%` : "",
    ctx.recentBars && ctx.recentBars.length > 0
      ? `Recent bars on instrument:\n${ctx.recentBars.map((b) => `  ${b.t}: O=${b.o} H=${b.h} L=${b.l} C=${b.c} V=${b.v}`).join("\n")}`
      : "",
    ctx.recentHeadlines && ctx.recentHeadlines.length > 0
      ? `Recent headlines:\n${ctx.recentHeadlines.map((h) => `  - ${h}`).join("\n")}`
      : "",
    ``,
    `=== RECENT PERFORMANCE (last ${recentTotal} closed trades) ===`,
    `Wins: ${recentWins}/${recentTotal} (${recentTotal > 0 ? ((recentWins / recentTotal) * 100).toFixed(0) : "0"}%)`,
    `Cumulative P&L: $${recentPnl.toFixed(2)}`,
    worst.length > 0 ? `` : "",
    worst.length > 0 ? `=== WORST PAST TRADES (LEARN FROM THESE) ===` : "",
    worst.length > 0 ? `These trades you previously approved went badly. Avoid setups with similar characteristics:` : "",
    ...worst.map((w, i) => `${i + 1}. ${w.strategy} ${w.side} ${w.key}: $${w.pnl.toFixed(0)} (your prior conviction: ${w.conviction}). Reasoning at time: "${w.reasoning.slice(0, 200)}"`),
  ].filter((l) => l !== "").join("\n");
}

function parseDecision(text: string): AgentDecision {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    log.warn("Brain response not JSON; rejecting", { preview: text.slice(0, 120) });
    return { go: false, conviction: 0, sizeMultiplier: 0, reasoning: "unparseable response" };
  }
  let parsed: Partial<AgentDecision>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Partial<AgentDecision>;
  } catch {
    return { go: false, conviction: 0, sizeMultiplier: 0, reasoning: "JSON parse error" };
  }
  const go = parsed.go === true;
  const conviction = clamp(num(parsed.conviction, 0), 0, 100);
  const sizeMultiplier = clamp(num(parsed.sizeMultiplier, 1), 0.25, 2.0);
  const revisedStop = typeof parsed.revisedStop === "number" && parsed.revisedStop > 0 ? parsed.revisedStop : undefined;
  const revisedTake = typeof parsed.revisedTake === "number" && parsed.revisedTake > 0 ? parsed.revisedTake : undefined;
  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
  return { go, conviction, sizeMultiplier, revisedStop, revisedTake, reasoning };
}

// System block (cached via Anthropic's ephemeral prompt cache). This text
// is identical on every call, so cache saves ~40-50% latency and ~90% cost.
const SYSTEM_PREFIX_FALLBACK = [
  "You are the trading brain for a permanent autonomous trading agent. Your job is to validate every proposed trade.",
  "",
  "Approve only setups with strong conviction. Reject anything questionable. Patience > activity. The agent runs all day; missing one trade is fine, taking a bad one is not.",
  "",
  "Evaluate each trade by considering:",
  "1. Setup quality given the strategy's known edge",
  "2. Whether the market regime supports this trade type right now",
  "3. Risk:reward and stop placement",
  "4. Time of day (avoid first/last 15 minutes of session unless explicit edge)",
  "5. Recent performance: if losing streak, be more selective; if winning streak, normal selectivity",
  "6. Concentration risk if we already have similar open positions",
  "",
  "Output EXACTLY this JSON shape, no other text:",
  "{",
  '  "go": true|false,',
  '  "conviction": 0-100,',
  '  "sizeMultiplier": 0.25-2.0,',
  '  "revisedStop": <number or null>,',
  '  "revisedTake": <number or null>,',
  '  "reasoning": "<one sentence>"',
  "}",
].join("\n");

function passThrough(): AgentDecision {
  return { go: true, conviction: 100, sizeMultiplier: 1.0, reasoning: "brain disabled, pass-through" };
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return (min + max) / 2;
  return Math.min(max, Math.max(min, n));
}

function num(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
