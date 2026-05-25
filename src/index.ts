// Gecko orchestrator. Wires the broker, scanners, strategies, risk, and
// execution layers into a running process.
//
// Daily cycle:
//   - Load config and tokens, connect Schwab REST + Stream
//   - On startup: fetch account hash (cached after first call), snapshot account
//   - Premarket (08:55-09:25 ET): run premarket scanner, load ORB candidates,
//     subscribe to LEVELONE_EQUITIES
//   - 09:30 ET: start ORB strategy, start Engine B (subscribes to SPY 0DTE)
//   - Continuous: position monitor polls open positions for exit conditions
//   - 16:00 ET: stop strategies, log daily summary
//
// LIVE_TRADING=false:
//   - Everything runs the same path, but OrderRouter logs orders to JSONL
//     instead of submitting via REST. Safe for paper-equivalent operation.

import { loadConfig } from "./core/config.js";
import { createLogger, setLogLevel } from "./core/logger.js";
import { etDate, etParts, isWeekdayET, sleep } from "./utils/time.js";
import { createBroker } from "./brokers/factory.js";
import { SchwabRest } from "./brokers/schwab/rest.js";
import { SchwabAuth } from "./brokers/schwab/auth.js";
import { HistoricalBars } from "./data/historical.js";
import { QuoteCache } from "./data/quote-cache.js";
import { PremarketScanner } from "./scanner/premarket.js";
import { OptionsChainMonitor } from "./scanner/options-chain.js";
import { OrbStrategy } from "./strategies/orb.js";
import { Dte0SpyStrategy } from "./strategies/dte0-spy.js";
import { DailyStop } from "./risk/daily-stop.js";
import { PdtTracker } from "./risk/pdt-tracker.js";
import { RiskManager } from "./risk/risk-manager.js";
import { PositionTracker } from "./execution/position-tracker.js";
import { PositionMonitor } from "./execution/position-monitor.js";
import { OrderRouter } from "./execution/order-router.js";
import { FillWatcher } from "./execution/fill-watcher.js";
import { autoClearIfExpired as autoClearKillSwitch, isLocked as killSwitchLocked, readLock as readKillSwitchLock, trip as tripKillSwitch } from "./risk/kill-switch-lock.js";
import { DrawdownTracker } from "./risk/drawdown-tracker.js";
import { TelegramNotifier } from "./monitoring/telegram.js";
import { DiscordNotifier } from "./monitoring/discord.js";
import { LlmClassifier } from "./intelligence/llm-classifier.js";
import { SelfTuner } from "./intelligence/self-tuner.js";
import { AgentBrain } from "./intelligence/agent-brain.js";
import { ConfluenceEngine } from "./intelligence/confluence.js";
import { MultiTimeframeValidator } from "./intelligence/multi-tf.js";
import { MarketInternals } from "./intelligence/market-internals.js";
import { NewsReader } from "./intelligence/news-reader.js";
import { PatternMatcher } from "./intelligence/pattern-matcher.js";
import { RegimeDetector } from "./intelligence/regime-detector.js";
import { ConvictionSizer } from "./risk/conviction-sizer.js";
import { EconomicCalendar } from "./intelligence/economic-calendar.js";
import { MeanReversionStrategy } from "./strategies/mean-reversion.js";
import type {
  AccountSnapshot,
  AppConfig,
  TradeSignal,
} from "./core/types.js";

const log = createLogger("main");

const ACCOUNT_REFRESH_MS = 60 * 1000;

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`FATAL: Config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  setLogLevel(config.logLevel);
  log.info("Gecko starting", {
    liveTrading: config.liveTrading,
    killSwitch: config.killSwitch,
    orbEnabled: config.orbEnabled,
    dte0Enabled: config.dte0Enabled,
    llmEnabled: config.llmEnabled,
  });

  // Auto-clear cooldown-expired locks (weekly/monthly DD trips that have
  // served their sleep period). Operator-triggered locks and peak-to-trough
  // trips do not have a cooldown and are NOT cleared here — they require
  // explicit `npm run unlock`.
  autoClearKillSwitch();

  // Refuse to start if the kill switch is still locked. Operator must clear
  // via `npm run unlock -- --by=... --reason=...` after manual review. This
  // is the friction that prevents an emotional `pm2 restart` from re-arming
  // a bot that just tripped a real risk event.
  if (killSwitchLocked()) {
    const lock = readKillSwitchLock();
    process.stderr.write(`FATAL: kill-switch lock present at data/kill-switch.lock\n`);
    process.stderr.write(`  source:    ${lock?.source ?? "unknown"}\n`);
    process.stderr.write(`  reason:    ${lock?.reason ?? "unknown"}\n`);
    process.stderr.write(`  timestamp: ${lock?.timestamp ?? "unknown"}\n`);
    process.stderr.write(`Clear with: npm run unlock -- --by="<name>" --reason="<justification>"\n`);
    process.exit(1);
  }

  // Trap unhandled errors. Either flavor trips the kill-switch lock so PM2's
  // auto-restart loop will not silently re-arm the bot; the operator has to
  // investigate and explicitly unlock. Best-effort logging happens before
  // exit so we always have a breadcrumb.
  process.on("uncaughtException", (err) => {
    const reason = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    try {
      log.error("Uncaught exception — tripping kill switch", { error: reason });
    } catch { /* logger may be unsafe inside a crash */ }
    tripKillSwitch({
      timestamp: new Date().toISOString(),
      source: "uncaught-exception",
      reason,
      stack,
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    try {
      log.error("Unhandled promise rejection — tripping kill switch", { error: msg });
    } catch { /* ignore */ }
    tripKillSwitch({
      timestamp: new Date().toISOString(),
      source: "unhandled-rejection",
      reason: msg,
      stack,
    });
    process.exit(1);
  });

  // ----- Broker (Schwab or IBKR per config) -----
  let broker;
  try {
    broker = await createBroker(config);
  } catch (err) {
    process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  log.info("Broker initialized", { broker: broker.name, latencyTargetMs: broker.orderLatencyTargetMs });

  // Authenticate the broker and resolve the trading account *before* any
  // call that uses it. Stream handler is wired later — the stream stays
  // idle (no subscriptions yet) until subscribeAccountActivity().
  try {
    await broker.start();
  } catch (err) {
    process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // Boot-time reconciliation: align the bot's in-memory view with what the
  // broker actually holds, BEFORE any strategy can fire. The conservative
  // v1 policy is "halt on any surprise" — if the broker reports ANY pre-
  // existing position or live order, we trip the kill switch and refuse to
  // start. The operator must investigate (was it a leftover from a crashed
  // session? a manual trade? a partial fill the bot didn't record?) and
  // then either flatten manually or explicitly clear the lock with a
  // reason. This prevents the failure mode the council ops review flagged:
  // "Node process exits between POST /orders and JSONL append; order fills;
  // PM2 restarts; position-tracker is empty; strategy re-enters same name."
  try {
    const [brokerPositions, brokerOpenOrders] = await Promise.all([
      broker.getPositions(),
      broker.getOpenOrders(),
    ]);
    log.info("Boot reconciliation", {
      brokerPositions: brokerPositions.length,
      brokerOpenOrders: brokerOpenOrders.length,
    });
    if (brokerPositions.length > 0 || brokerOpenOrders.length > 0) {
      const posSummary = brokerPositions.map((p) => ({
        sym: p.instrument.assetClass === "equity" ? p.instrument.symbol : p.instrument.osiSymbol,
        qty: p.quantity,
        avgCost: p.avgCost,
      }));
      const orderSummary = brokerOpenOrders.map((o) => ({
        orderId: o.orderId,
        sym: o.instrument.assetClass === "equity" ? o.instrument.symbol : o.instrument.osiSymbol,
        side: o.side,
        remaining: o.remaining,
        status: o.status,
      }));
      log.error("Reconciliation found pre-existing broker state — refusing to start", {
        positions: posSummary,
        orders: orderSummary,
      });
      tripKillSwitch({
        timestamp: new Date().toISOString(),
        source: "reconciliation-mismatch",
        reason: `Broker reports ${brokerPositions.length} position(s) and ${brokerOpenOrders.length} open order(s) at boot. Investigate and either flatten or clear the lock with an explicit reason.`,
      });
      process.stderr.write(`FATAL: pre-existing broker state at boot. See data/kill-switch.lock for details.\n`);
      process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Boot reconciliation failed", { error: msg });
    tripKillSwitch({
      timestamp: new Date().toISOString(),
      source: "reconciliation-mismatch",
      reason: `getPositions/getOpenOrders failed at boot: ${msg}`,
    });
    process.stderr.write(`FATAL: reconciliation failed at boot — kill switch tripped.\n`);
    process.exit(1);
  }

  // For historical data + scanner that still uses Schwab REST directly, we
  // also instantiate a SchwabRest where possible. Yahoo backtest path uses
  // its own fetcher; here we only need SchwabRest when BROKER=schwab.
  const schwabRestForScanner = config.broker === "schwab"
    ? (() => {
        const a = new SchwabAuth({
          clientId: config.schwabClientId,
          clientSecret: config.schwabClientSecret,
          redirectUri: config.schwabRedirectUri,
        });
        return new SchwabRest(a);
      })()
    : null;

  // ----- Account snapshot polling -----
  // Drawdown tracker persists to data/risk-state.json. On every account
  // refresh we hand it the current equity and it enforces weekly (-6%,
  // 48h cooldown), monthly (-10%, 7-day cooldown), and peak-to-trough
  // (-20%, manual unlock) limits via the kill-switch lock.
  const drawdownTracker = new DrawdownTracker();
  const accountState: { current: AccountSnapshot | null } = { current: null };
  const refreshAccount = async (): Promise<void> => {
    try {
      accountState.current = await broker.getAccountSnapshot();
      if (accountState.current) {
        drawdownTracker.update(accountState.current.equity);
      }
    } catch (err) {
      log.warn("Account snapshot refresh failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  await refreshAccount();
  const accountTimer = setInterval(() => {
    refreshAccount().catch(() => { /* logged inside */ });
  }, ACCOUNT_REFRESH_MS);
  accountTimer.unref?.();

  // ----- Risk layer -----
  const dailyStop = new DailyStop(config.dailyLossLimitPct);
  if (accountState.current) {
    dailyStop.resetForDay(etDate(), accountState.current.equity);
  }
  const pdt = new PdtTracker(config.maxDayTrades);
  const positions = new PositionTracker();
  const risk = new RiskManager(config, dailyStop, pdt, positions);

  // ----- Intelligence (created before execution so fill-watcher can wire it) -----
  const llm = new LlmClassifier({
    apiKey: config.anthropicApiKey,
    model: config.llmModel,
    enabled: config.llmEnabled && !!config.anthropicApiKey,
  });
  const tuner = new SelfTuner();
  const brain = new AgentBrain({
    apiKey: config.anthropicApiKey,
    model: config.llmModelBrain,                 // Opus 4.7 by default
    enabled: config.agentBrainEnabled && !!config.anthropicApiKey,
    minConviction: config.agentBrainMinConviction,
  });
  const confluenceEngine = new ConfluenceEngine({
    minSignals: 4,
    minScore: 0.65,
    requireUnanimity: false,    // allow up to 1 dissenter
  });
  const patternMatcher = new PatternMatcher();
  const newsReader = new NewsReader({
    apiKey: config.anthropicApiKey,
    model: config.llmModel,
    enabled: config.llmEnabled && !!config.anthropicApiKey,
  });

  // ----- Execution -----
  const router = new OrderRouter(config, broker, risk);
  const fillWatcher = new FillWatcher(broker, positions, tuner);
  fillWatcher.start();
  const quotes = new QuoteCache();
  const positionMonitor = new PositionMonitor(positions, router, quotes, fillWatcher, config.liveTrading);

  // Multi-timeframe validator pulls bars from HistoricalBars cache; the
  // strategies themselves keep these warm via the streaming layer + scanner.
  const multiTf = new MultiTimeframeValidator({
    getBars: (symbol, resolution, n) => {
      const ms = resolutionToMs(resolution);
      const end = Date.now();
      const start = end - n * ms - 60_000;
      // Synchronous best-effort: pull from the on-disk cache via HistoricalBars.
      // The fetch returns a promise; we expose a sync helper that returns
      // whatever's cached. If nothing cached, we return an empty array — the
      // validator handles that gracefully.
      try {
        return (historical as { peekCache?: (sym: string, freqType: string, freq: number, startMs: number, endMs: number) => readonly import("./core/types.js").Bar[] }).peekCache?.(symbol, resolution === "60m" ? "minute" : "minute", resolution === "1m" ? 1 : resolution === "5m" ? 5 : resolution === "15m" ? 15 : 60, start, end) ?? [];
      } catch {
        return [];
      }
    },
  });

  // Market internals tracker. Watches SPY and a subset of the watchlist for
  // breadth. Use a static seed list here; the live watchlist gets fed into
  // the internals tracker via captureOpens() at session start.
  const internals = new MarketInternals(quotes, ["SPY", "QQQ", "IWM", "DIA"]);

  router.setConfluence({
    engine: confluenceEngine,
    multiTf,
    internals,
    news: newsReader,
    patterns: patternMatcher,
  });

  // Conviction-based sizing + per-strategy adaptive tiers.
  const convictionSizer = new ConvictionSizer();
  router.setConvictionSizer(convictionSizer);
  tuner.onOutcome((outs) => convictionSizer.updateFromOutcomes(outs));

  // Regime-aware sizing. Captures SPY/VIX opens at session start.
  const regimeDetector = new RegimeDetector(quotes);
  router.setRegimeDetector(regimeDetector);

  // Wire the AI brain into the router so every entry trade is validated.
  router.setBrain({
    brain,
    getOpenPositions: () => positions.all(),
    getContext: (signal) => {
      const p = etParts();
      const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][p.dayOfWeek];
      const spyLast = quotes.getEquityPrice("SPY") ?? undefined;
      return {
        timeOfDayEt: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
        dayOfWeek: dow,
        spyChangePct: spyLast !== undefined ? undefined : undefined, // populated by orchestrator when reference is available
        recentBars: undefined,                                       // strategies can enrich signal.metadata with recent bars
      };
    },
  });

  // ----- Notifications -----
  const telegram = new TelegramNotifier(config.telegramBotToken, config.telegramChatId);
  const discord = new DiscordNotifier(config.discordWebhookUrl);

  // ----- Stream data routing -----
  // Historical bars + scanner + options-chain currently only have Schwab
  // backends. When BROKER=ibkr these become no-ops (return null/empty).
  const historical = schwabRestForScanner ? new HistoricalBars(schwabRestForScanner) : null;
  const scanner = schwabRestForScanner && historical ? new PremarketScanner(config, schwabRestForScanner, historical) : null;
  const chainMonitor = schwabRestForScanner ? new OptionsChainMonitor(schwabRestForScanner) : null;
  const orb = new OrbStrategy(config, broker);
  orb.setEconomicCalendar(new EconomicCalendar());
  orb.setWalkForward(tuner.getWalkForward());
  const dte0 = chainMonitor ? new Dte0SpyStrategy(config, broker, chainMonitor) : null;
  const meanReversion = new MeanReversionStrategy(config, broker, ["SPY", "QQQ"]);

  orb.setAccountProvider(() => accountState.current);
  meanReversion.setAccountProvider(() => accountState.current);
  dte0?.setAccountProvider(() => accountState.current);

  const handleSignal = async (signal: TradeSignal): Promise<void> => {
    const snapshot = accountState.current;
    if (!snapshot) {
      log.warn("Signal received but no account snapshot yet", { signalId: signal.id });
      return;
    }
    const result = await router.submit(signal, snapshot);
    const tag = result.accepted ? "Accepted" : "Rejected";
    const msg = `${tag}: ${signal.description}\n${result.reason}`;
    telegram.sendAlert(`Signal ${tag}`, msg).catch(() => {});
    discord.sendEmbed(`Signal ${tag}`, msg, result.accepted ? 0x00ff00 : 0xff8800).catch(() => {});

    // Hand off to the fill watcher only when a real order id came back. The
    // dry-run path has no orderId, so the watcher would poll forever.
    if (result.accepted && result.orderId && config.liveTrading) {
      fillWatcher.watch(result.orderId, result.approvedSignal ?? signal, "open");
    }
  };

  orb.setSignalHandler((s) => { handleSignal(s).catch((err) => log.error("orb handler", { error: errMsg(err) })); });
  meanReversion.setSignalHandler((s) => { handleSignal(s).catch((err) => log.error("mr handler", { error: errMsg(err) })); });
  dte0?.setSignalHandler((s) => { handleSignal(s).catch((err) => log.error("dte0 handler", { error: errMsg(err) })); });

  broker.setStreamHandler((kind, ticks) => {
    if (kind === "equity-tick") {
      for (const t of ticks) {
        quotes.setEquityPrice(t.symbol, t.last);
      }
      orb.handleEquityTick(ticks);
      meanReversion.handleEquityTick(ticks);
      // Feed SPY price into regime detector for adaptive sizing.
      for (const t of ticks) if (t.symbol === "SPY") regimeDetector.recordSpy(t.last, t.timestamp);
      regimeDetector.refresh();
      dte0?.handleEquityTick(ticks);
    } else if (kind === "option-tick") {
      for (const t of ticks) {
        quotes.setOptionPrice(t.symbol, t.last);
      }
      dte0?.handleOptionTick(ticks);
    } else if (kind === "account-activity") {
      log.info("Broker account-activity event", { count: ticks.length });
    }
  });

  await broker.subscribeAccountActivity();

  // ----- Daily orchestration -----
  await runDailyLoop({
    config,
    broker,
    scanner,
    llm,
    tuner,
    orb,
    meanReversion,
    dte0,
    positionMonitor,
    refreshAccount,
    notifyStartup: async (msg: string) => {
      await Promise.allSettled([
        telegram.sendAlert("Gecko", msg),
        discord.sendEmbed("Gecko", msg, 0x00aaff),
      ]);
    },
    telegram,
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutdown signal received: ${signal}`);
    orb.stop();
    meanReversion.stop();
    dte0?.stop();
    positionMonitor.stop();
    fillWatcher.stop();
    broker.stop();
    clearInterval(accountTimer);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // uncaughtException + unhandledRejection are wired earlier in main() so
  // they fire even if startup fails before reaching this point.
}

interface DailyLoopArgs {
  readonly config: AppConfig;
  readonly broker: import("./brokers/broker.js").Broker;
  readonly scanner: PremarketScanner | null;
  readonly llm: LlmClassifier;
  readonly tuner: SelfTuner;
  readonly orb: OrbStrategy;
  readonly meanReversion: MeanReversionStrategy;
  readonly dte0: Dte0SpyStrategy | null;
  readonly positionMonitor: PositionMonitor;
  readonly refreshAccount: () => Promise<void>;
  readonly notifyStartup: (msg: string) => Promise<void>;
  readonly telegram: TelegramNotifier;
}

async function runDailyLoop(args: DailyLoopArgs): Promise<void> {
  const { config, scanner, llm, tuner, orb, meanReversion, dte0, positionMonitor, refreshAccount, notifyStartup, broker, telegram } = args;

  positionMonitor.start();
  await notifyStartup(`Started. live=${config.liveTrading} orb=${config.orbEnabled} dte0=${config.dte0Enabled}`);

  // Main day loop. We don't aggressively sleep; let timers and stream handlers
  // do the work. This loop just orchestrates the daily phase transitions.
  let scannedToday: string | null = null;
  let startedToday: string | null = null;
  let healthCheckedToday: string | null = null;

  // Run forever. Daily phases are gated by ET time.
  while (true) {
    const p = etParts();
    const today = `${p.date}`;
    const minsOfDay = p.hour * 60 + p.minute;

    if (!isWeekdayET()) {
      await sleep(60_000);
      continue;
    }

    // Pre-open broker health check at 08:50 ET. If the IBKR session is
    // dead (typically because the daily 24h reset has passed and operator
    // hasn't re-logged in via browser), fire a CRITICAL Telegram alert
    // with a one-line playbook. Operator has ~40 min to fix before the
    // 09:30 ET ORB window opens.
    if (healthCheckedToday !== today && minsOfDay >= 8 * 60 + 50 && minsOfDay < 9 * 60) {
      try {
        const health = await broker.healthCheck();
        if (!health.ok) {
          log.error("Pre-open broker health check FAILED", { message: health.message });
          await telegram.sendAlert(
            "Gecko: IBKR session dead — re-auth needed before 09:30 ET",
            `Health: ${health.message}\n\nPlaybook:\n` +
              `1. ssh -L 5000:localhost:5000 root@<vps-ip>\n` +
              `2. Browser: https://localhost:5000 → log in → "Client login succeeds"\n` +
              `3. ssh root@<vps-ip> ; cd ~/project-gecko && npm run auth:ibkr\n` +
              `4. pm2 restart gecko-bot`,
          ).catch(() => { /* alert path is best-effort */ });
        } else {
          log.info("Pre-open broker health check OK", { message: health.message });
        }
        healthCheckedToday = today;
      } catch (err) {
        log.error("Pre-open broker health check threw", { error: errMsg(err) });
        // Don't mark healthCheckedToday — let the next loop iteration retry.
      }
    }

    // Premarket scan window: 09:00-09:25 ET.
    if (scanner && config.orbEnabled && scannedToday !== today && minsOfDay >= 9 * 60 && minsOfDay < 9 * 60 + 25) {
      try {
        log.info("Premarket scan starting");
        const raw = await scanner.scan();
        const top = raw.slice(0, 20);

        // LLM classification, gated by self-tuner score floor.
        const classifications = await llm.classify(top);
        const floor = tuner.getLlmScoreFloor();
        const scored = top
          .map((c, i) => ({ candidate: c, result: classifications[i] }))
          .filter((p) => p.result.score >= floor && p.result.direction !== "AVOID")
          .slice(0, 15);

        log.info("Premarket scan + classification complete", {
          rawCount: raw.length,
          topConsidered: top.length,
          surviving: scored.length,
          floor,
        });

        orb.loadCandidates(scored.map((p) => p.candidate));
        scannedToday = today;
      } catch (err) {
        log.error("Premarket scan failed", { error: errMsg(err) });
      }
    }

    // Strategy start at 09:30 ET (or thereabouts).
    if (startedToday !== today && minsOfDay >= 9 * 60 + 30 && minsOfDay < 14 * 60) {
      await refreshAccount();
      if (config.orbEnabled) {
        await orb.start().catch((err) => log.error("orb start failed", { error: errMsg(err) }));
        await meanReversion.start().catch((err) => log.error("mr start failed", { error: errMsg(err) }));
      }
      if (dte0 && config.dte0Enabled) {
        await dte0.start().catch((err) => log.error("dte0 start failed", { error: errMsg(err) }));
      }
      startedToday = today;
    }

    // End-of-day stop at 16:00 ET.
    if (startedToday === today && minsOfDay >= 16 * 60) {
      orb.stop();
      meanReversion.stop();
      dte0?.stop();
      startedToday = null;
    }

    await sleep(30_000);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolutionToMs(res: "1m" | "5m" | "15m" | "60m"): number {
  switch (res) {
    case "1m": return 60_000;
    case "5m": return 5 * 60_000;
    case "15m": return 15 * 60_000;
    case "60m": return 60 * 60_000;
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
