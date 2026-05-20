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
import { SchwabAuth } from "./brokers/schwab/auth.js";
import { SchwabRest } from "./brokers/schwab/rest.js";
import { SchwabStream } from "./brokers/schwab/stream.js";
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
import { TelegramNotifier } from "./monitoring/telegram.js";
import { DiscordNotifier } from "./monitoring/discord.js";
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

  // ----- Broker auth + clients -----
  const auth = new SchwabAuth({
    clientId: config.schwabClientId,
    clientSecret: config.schwabClientSecret,
    redirectUri: config.schwabRedirectUri,
  });
  const loaded = await auth.load();
  if (!loaded) {
    process.stderr.write("FATAL: No persisted tokens. Run `npm run auth` first.\n");
    process.exit(1);
  }
  auth.startAutoRefresh();

  const rest = new SchwabRest(auth);
  const stream = new SchwabStream(auth, rest);

  // ----- Resolve account hash (from config, verified against API) -----
  let accountHash = config.schwabAccountHash;
  try {
    const accountList = await rest.getAccountNumbers();
    const match = accountList.find((a) => a.hashValue === config.schwabAccountHash);
    if (!match) {
      log.warn("Configured account hash not found in account list; using first available", {
        configured: config.schwabAccountHash.slice(0, 8) + "...",
        firstAvailable: accountList[0]?.hashValue.slice(0, 8) + "...",
      });
      if (accountList[0]) accountHash = accountList[0].hashValue;
    }
  } catch (err) {
    log.error("Failed to fetch account numbers; using configured hash as-is", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ----- Account snapshot polling -----
  const accountState: { current: AccountSnapshot | null } = { current: null };
  const refreshAccount = async (): Promise<void> => {
    try {
      const acct = await rest.getAccount(accountHash, true);
      const cur = acct.securitiesAccount.currentBalances;
      accountState.current = {
        cashBalance: cur?.cashBalance ?? 0,
        buyingPower: cur?.buyingPower ?? 0,
        dayTradeBuyingPower: cur?.dayTradingBuyingPower ?? cur?.buyingPower ?? 0,
        equity: cur?.equity ?? cur?.liquidationValue ?? 0,
        dayTradeCount: acct.securitiesAccount.roundTrips ?? 0,
        timestamp: Date.now(),
      };
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

  // ----- Execution -----
  const router = new OrderRouter(config, rest, risk, accountHash);
  const fillWatcher = new FillWatcher(rest, positions, accountHash);
  fillWatcher.start();
  const quotes = new QuoteCache();
  const positionMonitor = new PositionMonitor(positions, router, quotes, fillWatcher, config.liveTrading);

  // ----- Notifications -----
  const telegram = new TelegramNotifier(config.telegramBotToken, config.telegramChatId);
  const discord = new DiscordNotifier(config.discordWebhookUrl);

  // ----- Stream data routing -----
  const historical = new HistoricalBars(rest);
  const scanner = new PremarketScanner(config, rest, historical);
  const chainMonitor = new OptionsChainMonitor(rest);
  const orb = new OrbStrategy(config, stream);
  const dte0 = new Dte0SpyStrategy(config, stream, chainMonitor);

  orb.setAccountProvider(() => accountState.current);
  dte0.setAccountProvider(() => accountState.current);

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
      fillWatcher.watch(result.orderId, signal, "open");
    }
  };

  orb.setSignalHandler((s) => { handleSignal(s).catch((err) => log.error("orb handler", { error: errMsg(err) })); });
  dte0.setSignalHandler((s) => { handleSignal(s).catch((err) => log.error("dte0 handler", { error: errMsg(err) })); });

  stream.setDataHandler((service, content) => {
    if (service === "LEVELONE_EQUITIES") {
      // Feed quote cache and route to strategies that subscribe.
      for (const row of content) {
        const sym = typeof row["0"] === "string" ? (row["0"] as string) : "";
        const last = typeof row["3"] === "number" ? (row["3"] as number) : NaN;
        if (sym && Number.isFinite(last) && last > 0) quotes.setEquityPrice(sym, last);
      }
      orb.handleEquityTick(content);
      dte0.handleEquityTick(content);
    } else if (service === "LEVELONE_OPTIONS") {
      for (const row of content) {
        const sym = typeof row["0"] === "string" ? (row["0"] as string) : "";
        // Field 38 = mark; fields 2/3 = bid/ask.
        const bid = typeof row["2"] === "number" ? (row["2"] as number) : NaN;
        const ask = typeof row["3"] === "number" ? (row["3"] as number) : NaN;
        const mark = typeof row["38"] === "number" ? (row["38"] as number) : NaN;
        const px = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
          ? (bid + ask) / 2
          : (Number.isFinite(mark) ? mark : NaN);
        if (sym && Number.isFinite(px) && px > 0) quotes.setOptionPrice(sym, px);
      }
      dte0.handleOptionTick(content);
    } else if (service === "ACCT_ACTIVITY") {
      log.info("ACCT_ACTIVITY event", { count: content.length });
      // TODO: parse message types and route fills into positions.open(),
      // cancellations into a router state map. For now, log only.
    }
  });

  log.info("Starting stream");
  await stream.start();
  stream.subscribeAccountActivity();

  // ----- Daily orchestration -----
  await runDailyLoop({
    config,
    scanner,
    orb,
    dte0,
    positionMonitor,
    refreshAccount,
    notifyStartup: async (msg: string) => {
      await Promise.allSettled([
        telegram.sendAlert("Gecko", msg),
        discord.sendEmbed("Gecko", msg, 0x00aaff),
      ]);
    },
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutdown signal received: ${signal}`);
    orb.stop();
    dte0.stop();
    positionMonitor.stop();
    fillWatcher.stop();
    stream.stop();
    auth.stopAutoRefresh();
    clearInterval(accountTimer);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled promise rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

interface DailyLoopArgs {
  readonly config: AppConfig;
  readonly scanner: PremarketScanner;
  readonly orb: OrbStrategy;
  readonly dte0: Dte0SpyStrategy;
  readonly positionMonitor: PositionMonitor;
  readonly refreshAccount: () => Promise<void>;
  readonly notifyStartup: (msg: string) => Promise<void>;
}

async function runDailyLoop(args: DailyLoopArgs): Promise<void> {
  const { config, scanner, orb, dte0, positionMonitor, refreshAccount, notifyStartup } = args;

  positionMonitor.start();
  await notifyStartup(`Started. live=${config.liveTrading} orb=${config.orbEnabled} dte0=${config.dte0Enabled}`);

  // Main day loop. We don't aggressively sleep; let timers and stream handlers
  // do the work. This loop just orchestrates the daily phase transitions.
  let scannedToday: string | null = null;
  let startedToday: string | null = null;

  // Run forever. Daily phases are gated by ET time.
  while (true) {
    const p = etParts();
    const today = `${p.date}`;
    const minsOfDay = p.hour * 60 + p.minute;

    if (!isWeekdayET()) {
      await sleep(60_000);
      continue;
    }

    // Premarket scan window: 09:00-09:25 ET.
    if (config.orbEnabled && scannedToday !== today && minsOfDay >= 9 * 60 && minsOfDay < 9 * 60 + 25) {
      try {
        log.info("Premarket scan starting");
        const candidates = await scanner.scan();
        const top = candidates.slice(0, 15);
        log.info("Premarket scan complete", { count: top.length });
        orb.loadCandidates(top);
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
      }
      if (config.dte0Enabled) {
        await dte0.start().catch((err) => log.error("dte0 start failed", { error: errMsg(err) }));
      }
      startedToday = today;
    }

    // End-of-day stop at 16:00 ET.
    if (startedToday === today && minsOfDay >= 16 * 60) {
      orb.stop();
      dte0.stop();
      startedToday = null;
    }

    await sleep(30_000);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
