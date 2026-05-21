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
import { MeanReversionStrategy } from "../strategies/mean-reversion.js";
import { PairsTraderStrategy } from "../strategies/pairs-trader.js";
import { EarningsCatalystStrategy } from "../strategies/earnings-catalyst.js";
import { SectorStrength, SECTOR_ETFS } from "../intelligence/sector-strength.js";
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
import { RegimeDetector } from "../intelligence/regime-detector.js";
import { ConvictionSizer } from "../risk/conviction-sizer.js";
import { etParts } from "../utils/time.js";
import { YahooHistoricalBars } from "../data/yahoo-historical.js";
import type { AppConfig, AccountSnapshot, TradeSignal, Bar } from "../core/types.js";
import type { GapCandidate } from "../scanner/premarket.js";

const DEFAULT_SYMBOLS = ["SPY", "PLTR", "SOFI", "MARA", "RIOT", "NIO", "RIVN", "F"];

interface Args {
  symbols: string[];
  days: number;
  interval: "1m" | "5m" | "15m";
  equity: number;
  brainEnabled: boolean;
  newsEnabled: boolean;
  enableExperimental: boolean;
}

function parseArgs(): Args {
  const out: Args = {
    symbols: [...DEFAULT_SYMBOLS],
    days: 5,
    interval: "5m",
    equity: 5_000,
    brainEnabled: false,
    newsEnabled: false,
    enableExperimental: false,
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
    else if (a === "--experimental") out.enableExperimental = true;
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
    agentBrainMinConvictionLong: 55,
    agentBrainMinConvictionShort: 75,
    kellyEnabled: false,
    kellyFraction: 0.25,
    regimeAwareEnabled: false,
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
  // Shadow uses a permissive conviction threshold (60) so we can measure how
  // the agent would have actually traded on real bars. Production keeps 70.
  const brain = new AgentBrain({
    apiKey: config.anthropicApiKey, model: config.llmModel,
    enabled: config.agentBrainEnabled && !!config.anthropicApiKey,
    minConviction: args.brainEnabled ? 60 : config.agentBrainMinConviction,
    minConvictionLong: args.brainEnabled ? 55 : undefined,
    minConvictionShort: args.brainEnabled ? 75 : undefined,
  });
  // Shadow uses permissive confluence so we can see the full pipeline execute.
  // The brain is the strict gate; confluence is a cheap pre-filter. Cold-start
  // shadow has no pattern history and limited internals data, so requiring 3+
  // sources to vote 0.5+ is unrealistic. Production with real running data has
  // richer signal sources.
  const confluence = new ConfluenceEngine({
    minSignals: args.brainEnabled ? 2 : 1,
    minScore: args.brainEnabled ? 0.3 : 0.2,
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

  // Sector strength only wired when experimental is enabled — needs
  // proper A/B validation before being default in shadow.
  const sectorStrength = args.enableExperimental ? new SectorStrength(quotes) : undefined;
  router.setConfluence({
    engine: confluence,
    multiTf,
    internals,
    news: newsReader,
    patterns: patternMatcher,
    sectorStrength,
  });

  // Conviction-based sizing: brain conviction drives risk per trade.
  router.setConvictionSizer(new ConvictionSizer());

  // Regime detector: market regime tweaks the size multiplier.
  const regimeDetector = new RegimeDetector(quotes);
  router.setRegimeDetector(regimeDetector);
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

  const meanReversion = new MeanReversionStrategy(config, broker, ["SPY", "QQQ"]);
  meanReversion.setAccountProvider(() => accountSnapshot());

  // Pairs trader and earnings catalyst are built but disabled by default in
  // shadow until each is A/B tested against the proven ORB+MR baseline. The
  // last attempt of adding them all at once produced a regression from
  // +20.7% to -22% on a 30-day sample.
  const pairsTrader = args.enableExperimental ? new PairsTraderStrategy(config, broker) : null;
  pairsTrader?.setAccountProvider(() => accountSnapshot());

  const earningsCatalyst = args.enableExperimental
    ? new EarningsCatalystStrategy(config, broker, args.symbols.filter((s) => s !== "SPY" && s !== "QQQ"))
    : null;
  earningsCatalyst?.setAccountProvider(() => accountSnapshot());


  // Counters for the end-of-run report.
  const stats = {
    signalsEmitted: 0,
    signalsAccepted: 0,
    signalsRejected: 0,
    rejectByReason: new Map<string, number>(),
  };

  const handleSignal = async (s: TradeSignal): Promise<void> => {
    stats.signalsEmitted++;
    const snap = accountSnapshot();
    const result = await router.submit(s, snap);
    if (result.accepted) {
      stats.signalsAccepted++;
      process.stdout.write(`ACCEPT ${s.strategy} ${s.description}\n  reason: ${result.reason}\n`);
      if (result.orderId) {
        fillWatcher.watch(result.orderId, s, "open");
      }
    } else {
      stats.signalsRejected++;
      const bucket = bucketReason(result.reason);
      stats.rejectByReason.set(bucket, (stats.rejectByReason.get(bucket) ?? 0) + 1);
    }
  };
  orb.setSignalHandler((s) => { handleSignal(s).catch(() => {}); });
  meanReversion.setSignalHandler((s) => { handleSignal(s).catch(() => {}); });
  pairsTrader?.setSignalHandler((s) => { handleSignal(s).catch(() => {}); });
  earningsCatalyst?.setSignalHandler((s) => { handleSignal(s).catch(() => {}); });

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
  // Also drive position-monitor exit checks on EVERY tick so stop/take fills
  // happen at the correct price. (In live mode the 2-second poll handles
  // exits; in shadow the 29k-tick burst would otherwise leave the poll firing
  // only once at the very end with stale prices.)
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
        // Feed SPY/QQQ into the regime detector if present.
        if (t.symbol === "SPY") regimeDetector.recordSpy(t.last, t.timestamp);
      }
      orb.handleEquityTick(ticks);
      meanReversion.handleEquityTick(ticks);
      pairsTrader?.handleEquityTick(ticks);
      earningsCatalyst?.handleEquityTick(ticks);
      // Refresh regime every tick (cheap; recomputes once per minute internally).
      regimeDetector.refresh();
      // Synchronous exit check on every tick batch (cheap; no-op when no open positions).
      positionMonitor.probeNow().catch(() => { /* logged inside */ });
    }
  });

  // ----- Pre-compute per-day real gap candidates from historical data -----
  // For each replay day, derive each symbol's actual gap (previous close vs
  // first regular-session open). Filter by min gap pct. ORB.loadCandidates()
  // gets called at each day boundary with the real candidates.
  const candidatesByDay = await computeDailyGapCandidates(args.symbols, args.days, args.interval);
  process.stdout.write(`Pre-computed gap candidates: ${candidatesByDay.size} days have qualifying gappers\n`);

  await orb.start();
  await meanReversion.start();
  if (pairsTrader) await pairsTrader.start();
  if (earningsCatalyst) await earningsCatalyst.start();
  // Subscribe to sector ETFs so SectorStrength has data (only used if
  // experimental is enabled).
  if (args.enableExperimental) await broker.subscribeEquities([...SECTOR_ETFS]);
  positionMonitor.start();

  // ----- Run the replay with per-day candidate refresh -----
  const replay = new ReplayEngine({
    symbols: args.symbols,
    interval: args.interval,
    lookbackDays: args.days,
    broker,
    mode: "fast",
    setNow,
    onNewDay: async (date) => {
      const dayCands = candidatesByDay.get(date) ?? [];
      orb.loadCandidates(dayCands);
      if (dayCands.length > 0) {
        process.stdout.write(`[${date}] ${dayCands.length} gappers loaded: ${dayCands.map((c) => `${c.instrument.symbol}${c.direction === "UP" ? "+" : "-"}${c.gapPct.toFixed(1)}%`).join(" ")}\n`);
      }
    },
  });

  const replayResult = await replay.run();

  // Allow async tasks (Claude calls, fill polling, position monitor) to settle.
  // With brain+news enabled, individual signals can take 10-20 seconds. We
  // wait until pending router calls have all returned + extra slack.
  await sleep(args.brainEnabled || args.newsEnabled ? 30_000 : 4_500);
  orb.stop();
  meanReversion.stop();
  pairsTrader?.stop();
  earningsCatalyst?.stop();
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

// Pre-compute the real gap candidates per day for each symbol in the watchlist.
// Method: pull daily bars; for each day, gap = (today's open - yesterday's close)
// / yesterday's close. Keep symbols with |gap| >= 1% to leave room for ORB
// (production uses 2-3%; shadow uses 1% for more sample).
async function computeDailyGapCandidates(
  symbols: readonly string[],
  lookbackDays: number,
  _interval: "1m" | "5m" | "15m",
): Promise<Map<string, GapCandidate[]>> {
  const yahoo = new YahooHistoricalBars();
  const now = realDateNow();
  const byDay = new Map<string, GapCandidate[]>();

  for (const sym of symbols) {
    const dailyBars = await yahoo.fetch({
      symbol: sym,
      interval: "1d" as never,                 // YahooHistoricalBars only knows 1m/5m/15m/1h/1d — see fetcher types
      startMs: now - (lookbackDays + 10) * 24 * 60 * 60 * 1000,
      endMs: now,
      includePrePost: false,
    } as never);
    for (let i = 1; i < dailyBars.length; i++) {
      const prev = dailyBars[i - 1];
      const today = dailyBars[i];
      if (prev.close <= 0 || today.open <= 0) continue;
      const gapPct = ((today.open - prev.close) / prev.close) * 100;
      if (Math.abs(gapPct) < 1.0) continue;
      const date = new Date(today.timestamp).toISOString().slice(0, 10);
      const cand: GapCandidate = {
        instrument: { assetClass: "equity", symbol: sym },
        previousClose: prev.close,
        premarketPrice: today.open,
        gapPct,
        premarketVolume: 1_000_000,
        direction: gapPct > 0 ? "UP" : "DOWN",
      };
      const arr = byDay.get(date) ?? [];
      arr.push(cand);
      byDay.set(date, arr);
    }
  }
  return byDay;
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
