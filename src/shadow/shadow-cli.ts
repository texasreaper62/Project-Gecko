// Shadow harness CLI: replays historical bars through the LIVE pipeline.
//
// Usage:
//   npm run shadow                          # default watchlist, 5d, 5m bars
//   npm run shadow -- --symbols=SPY,PLTR    # custom symbols
//   npm run shadow -- --days=10 --interval=5m
//
// What it tests:
//   - Strategy signal generation (ORB)
//   - Confluence engine fail-fast
//   - Agent brain validation (with cached Claude calls)
//   - Risk manager checks
//   - Order routing (to ShadowBroker which simulates fills)
//   - Position tracker / monitor / fill watcher loop
//
// No real orders. No real credentials needed for any of this. Optional:
// ANTHROPIC_API_KEY to actually exercise the brain. Without it the brain
// is in pass-through mode and you see the rules-only pipeline.
//
// Important: we monkey-patch Date.now() so the bot's time helpers (etParts,
// isRegularSession, etc.) report the historical bar's timestamp rather than
// wall-clock time. Without this the strategies would think every replay is
// happening "right now" and the OR window gating would never fire.

import { setLogLevel } from "../core/logger.js";
import { ShadowBroker } from "./shadow-broker.js";
import { ReplayEngine } from "./replay.js";
import { QuoteCache } from "../data/quote-cache.js";
import { PositionTracker } from "../execution/position-tracker.js";
import { PositionMonitor } from "../execution/position-monitor.js";
import { OrderRouter } from "../execution/order-router.js";
import { FillWatcher } from "../execution/fill-watcher.js";
import { OrbStrategy } from "../strategies/orb.js";
import { DailyStop } from "../risk/daily-stop.js";
import { PdtTracker } from "../risk/pdt-tracker.js";
import { RiskManager } from "../risk/risk-manager.js";
import { SelfTuner } from "../intelligence/self-tuner.js";
import { AgentBrain } from "../intelligence/agent-brain.js";
import { ConfluenceEngine } from "../intelligence/confluence.js";
import { MultiTimeframeValidator } from "../intelligence/multi-tf.js";
import { MarketInternals } from "../intelligence/market-internals.js";
import { NewsReader } from "../intelligence/news-reader.js";
import { PatternMatcher } from "../intelligence/pattern-matcher.js";
import { etParts } from "../utils/time.js";
import type { AppConfig, AccountSnapshot, TradeSignal, Bar } from "../core/types.js";
import type { GapCandidate } from "../scanner/premarket.js";

const DEFAULT_SYMBOLS = ["PLTR", "SOFI", "MARA", "RIOT", "NIO", "RIVN", "F"];

interface Args {
  symbols: string[];
  days: number;
  interval: "1m" | "5m" | "15m";
  equity: number;
  brainEnabled: boolean;
  newsEnabled: boolean;
}

function parseArgs(): Args {
  const out: Args = {
    symbols: [...DEFAULT_SYMBOLS],
    days: 5,
    interval: "5m",
    equity: 5_000,
    brainEnabled: false,
    newsEnabled: false,
  };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--symbols=")) {
      out.symbols = a.slice("--symbols=".length).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    } else if (a.startsWith("--days=")) out.days = Number(a.slice("--days=".length));
    else if (a.startsWith("--interval=")) {
      const v = a.slice("--interval=".length) as Args["interval"];
      if (v === "1m" || v === "5m" || v === "15m") out.interval = v;
    } else if (a.startsWith("--equity=")) out.equity = Number(a.slice("--equity=".length));
    else if (a === "--brain") out.brainEnabled = true;
    else if (a === "--news") out.newsEnabled = true;
  }
  return out;
}

// Patch Date.now so the bot's time helpers see the historical timestamp.
let virtualNow = Date.now();
const realDateNow = Date.now.bind(Date);
Date.now = () => virtualNow;
function setNow(ms: number): void { virtualNow = ms; }

async function main(): Promise<void> {
  const args = parseArgs();
  setLogLevel("info");

  process.stdout.write(`\n===== Shadow Harness =====\n`);
  process.stdout.write(`Symbols (${args.symbols.length}): ${args.symbols.join(", ")}\n`);
  process.stdout.write(`Lookback: ${args.days} days @ ${args.interval} bars\n`);
  process.stdout.write(`Starting equity: $${args.equity}\n`);
  process.stdout.write(`Brain: ${args.brainEnabled ? "enabled (real Claude calls)" : "disabled (pass-through)"}\n`);
  process.stdout.write(`News reader: ${args.newsEnabled ? "enabled (real Yahoo+Claude)" : "disabled"}\n\n`);

  // Build a synthetic AppConfig sufficient for the in-process pipeline.
  const config: AppConfig = {
    broker: "schwab",
    schwabClientId: "shadow", schwabClientSecret: "shadow", schwabRedirectUri: "", schwabAccountHash: "shadow",
    ibkrBaseUrl: "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    llmEnabled: args.newsEnabled,
    llmModel: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
    agentBrainEnabled: args.brainEnabled,
    agentBrainMinConviction: 70,
    liveTrading: true,             // we want the router to dispatch, ShadowBroker simulates
    killSwitch: false,
    maxRiskPerTradePct: 1.0,
    maxConcurrentEquityPositions: 5,
    maxConcurrentOptionPositions: 2,
    dailyLossLimitPct: 10,
    maxDayTrades: 100,              // ignore PDT for shadow
    orbEnabled: true,
    orbMinGapPct: 2.0,
    orbMinPremarketVolume: 100_000,
    orbMinPrice: 5,
    orbMaxPrice: 100,
    dte0Enabled: false,
    dte0MaxContractsPerTrade: 1,
    dte0MaxTradesPerDay: 2,
    telegramBotToken: "", telegramChatId: "", discordWebhookUrl: "",
    logLevel: "info",
  };

  // ----- Build pipeline -----
  const broker = new ShadowBroker({ startingEquity: args.equity });
  await broker.start();

  const positions = new PositionTracker();
  const dailyStop = new DailyStop(config.dailyLossLimitPct);
  dailyStop.resetForDay(etParts().date, args.equity);
  const pdt = new PdtTracker(config.maxDayTrades);
  const risk = new RiskManager(config, dailyStop, pdt, positions);

  const tuner = new SelfTuner();
  const brain = new AgentBrain({
    apiKey: config.anthropicApiKey, model: config.llmModel,
    enabled: config.agentBrainEnabled && !!config.anthropicApiKey,
    minConviction: config.agentBrainMinConviction,
  });
  // Shadow uses permissive confluence so we can see the full pipeline execute
  // even when news/brain are disabled. Production keeps the strict settings.
  const confluence = new ConfluenceEngine({
    minSignals: args.brainEnabled && args.newsEnabled ? 3 : 1,
    minScore: args.brainEnabled && args.newsEnabled ? 0.5 : 0.2,
    requireUnanimity: false,
  });
  const patternMatcher = new PatternMatcher();
  const newsReader = new NewsReader({
    apiKey: config.anthropicApiKey, model: config.llmModel,
    enabled: config.llmEnabled && !!config.anthropicApiKey,
  });

  const router = new OrderRouter(config, broker, risk);
  const fillWatcher = new FillWatcher(broker, positions, tuner);
  fillWatcher.start();
  const quotes = new QuoteCache();
  const positionMonitor = new PositionMonitor(positions, router, quotes, fillWatcher, true);

  // Bars cache: we accumulate bars per symbol so multi-tf can read.
  const barsBySymbol: Map<string, Bar[]> = new Map();
  const multiTf = new MultiTimeframeValidator({
    getBars: (sym, _res, n) => {
      const arr = barsBySymbol.get(sym.toUpperCase()) ?? [];
      return arr.slice(-n);
    },
  });
  const internals = new MarketInternals(quotes, ["SPY", "QQQ", "IWM"]);

  router.setConfluence({
    engine: confluence,
    multiTf,
    internals,
    news: newsReader,
    patterns: patternMatcher,
  });
  router.setBrain({
    brain,
    getOpenPositions: () => positions.all(),
    getContext: () => {
      const p = etParts();
      return {
        timeOfDayEt: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
        dayOfWeek: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][p.dayOfWeek],
      };
    },
  });

  const orb = new OrbStrategy(config, broker);
  orb.setAccountProvider(() => accountSnapshot());

  // Counters for the end-of-run report.
  const stats = {
    signalsEmitted: 0,
    signalsAccepted: 0,
    signalsRejected: 0,
    rejectByReason: new Map<string, number>(),
  };

  orb.setSignalHandler(async (s: TradeSignal) => {
    stats.signalsEmitted++;
    const snap = accountSnapshot();
    const result = await router.submit(s, snap);
    if (result.accepted) {
      stats.signalsAccepted++;
      process.stdout.write(`ACCEPT ${s.strategy} ${s.description}\n  reason: ${result.reason}\n`);
      // Register the fill watcher so position tracker hydrates on fill.
      if (result.orderId) {
        fillWatcher.watch(result.orderId, s, "open");
      }
    } else {
      stats.signalsRejected++;
      const bucket = bucketReason(result.reason);
      stats.rejectByReason.set(bucket, (stats.rejectByReason.get(bucket) ?? 0) + 1);
    }
  });

  // ----- Account snapshot updates from ShadowBroker -----
  let cached: AccountSnapshot | null = null;
  function accountSnapshot(): AccountSnapshot {
    return cached ?? {
      cashBalance: args.equity, buyingPower: args.equity * 4, dayTradeBuyingPower: args.equity * 4,
      equity: args.equity, dayTradeCount: 0, timestamp: virtualNow,
    };
  }
  setInterval(async () => { cached = await broker.getAccountSnapshot(); }, 5_000).unref?.();

  // ----- Stream handler: route shadow ticks to ORB + QuoteCache + bars cache -----
  broker.setStreamHandler((kind, ticks) => {
    if (kind === "equity-tick") {
      for (const t of ticks) {
        quotes.setEquityPrice(t.symbol, t.last);
        const arr = barsBySymbol.get(t.symbol.toUpperCase()) ?? [];
        arr.push({
          symbol: t.symbol, timestamp: t.timestamp, open: t.last, high: t.last,
          low: t.last, close: t.last, volume: t.volume ?? 0,
        });
        if (arr.length > 200) arr.shift();
        barsBySymbol.set(t.symbol.toUpperCase(), arr);
      }
      orb.handleEquityTick(ticks);
    }
  });

  // ----- Load shadow candidates and run ORB -----
  // Build synthetic gap candidates so ORB has something to watch. We assume
  // each requested symbol gapped 3% UP at the open; the actual entry logic
  // still decides direction based on the realized opening range.
  const candidates: GapCandidate[] = args.symbols.map((sym) => ({
    instrument: { assetClass: "equity", symbol: sym },
    previousClose: 0,
    premarketPrice: 0,
    gapPct: 3,
    premarketVolume: 1_000_000,
    direction: "UP",
  }));
  orb.loadCandidates(candidates);
  await orb.start();
  positionMonitor.start();

  // ----- Run the replay -----
  const replay = new ReplayEngine({
    symbols: args.symbols,
    interval: args.interval,
    lookbackDays: args.days,
    broker,
    mode: "fast",
    setNow,
  });

  const replayResult = await replay.run();

  // Allow async tasks (fill polling on 2s cadence, position monitor) to settle.
  await sleep(4_500);
  orb.stop();
  positionMonitor.stop();
  fillWatcher.stop();
  broker.stop();

  // Track which positions opened (post fill-watcher polling).
  const opened = positions.all();
  process.stdout.write(`\n===== Positions opened during shadow run =====\n`);
  for (const p of opened) {
    const key = p.instrument.assetClass === "equity" ? p.instrument.symbol : p.instrument.osiSymbol;
    process.stdout.write(`  ${p.strategy} ${p.side} ${key} qty=${p.quantity} entry=${p.entryPrice.toFixed(2)} (held ${((Date.now() - p.openTimestamp) / 1000).toFixed(0)}s)\n`);
  }

  const brokerStats = broker.getStats();
  process.stdout.write(`\n===== Shadow run summary =====\n`);
  process.stdout.write(`Replay: ${replayResult.totalTicks} ticks in ${replayResult.durationMs}ms\n`);
  process.stdout.write(`Signals emitted: ${stats.signalsEmitted}\n`);
  process.stdout.write(`  accepted: ${stats.signalsAccepted}\n`);
  process.stdout.write(`  rejected: ${stats.signalsRejected}\n`);
  process.stdout.write(`Reject reasons:\n`);
  for (const [bucket, count] of Array.from(stats.rejectByReason.entries()).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`    ${bucket}: ${count}\n`);
  }
  process.stdout.write(`\nShadow broker:\n`);
  process.stdout.write(`  Orders submitted: ${brokerStats.orders}\n`);
  process.stdout.write(`  Filled: ${brokerStats.fills}\n`);
  process.stdout.write(`  Rejected: ${brokerStats.rejects}\n`);
  process.stdout.write(`  Final cash: $${brokerStats.cash.toFixed(2)}\n`);
  process.stdout.write(`  Final positions held: ${positions.all().length}\n`);

  // Restore real Date.now for clean exit.
  Date.now = realDateNow;
}

function bucketReason(r: string): string {
  if (r.startsWith("confluence")) return "confluence";
  if (r.startsWith("brain")) return "brain";
  if (r.startsWith("tier-1")) return "tier-1";
  if (r.includes("buying power")) return "buying-power";
  if (r.includes("position")) return "position-cap";
  if (r.includes("PDT")) return "pdt";
  if (r.includes("kill")) return "kill-switch";
  return r.split(":")[0] || "other";
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
