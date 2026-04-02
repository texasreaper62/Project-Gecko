import { loadConfig } from "./core/config.js";
import { createLogger, setLogLevel } from "./core/logger.js";
import type { AppConfig, Opportunity } from "./core/types.js";

// Feeds
import { BinanceFeed } from "./feeds/binance-ws.js";
import { CoinbaseFeed } from "./feeds/coinbase-ws.js";
import { PolymarketRestClient } from "./feeds/polymarket-rest.js";
import { PolymarketWsFeed } from "./feeds/polymarket-ws.js";
import { FeedAggregator } from "./feeds/feed-aggregator.js";

// Strategies
import { TemporalArbStrategy } from "./strategies/temporal-arb.js";
import { CorrelatedContractsStrategy } from "./strategies/correlated-contracts.js";

// Execution
import { OrderBuilder } from "./execution/order-builder.js";
import { OrderExecutor } from "./execution/order-executor.js";
import { RiskManager } from "./execution/risk-manager.js";
import { PositionTracker } from "./execution/position-tracker.js";

// Monitoring
import { TelegramNotifier } from "./monitoring/telegram.js";
import { DiscordNotifier } from "./monitoring/discord.js";
import { PnlTracker } from "./monitoring/pnl-tracker.js";
import { HealthChecker } from "./monitoring/health-check.js";
import { DailyReporter } from "./monitoring/daily-report.js";
import { WalletMonitor } from "./monitoring/wallet-monitor.js";

// Position management
import { PositionCloser } from "./execution/position-closer.js";

// Self-improvement
import { SelfTuner } from "./strategies/self-tuner.js";

const log = createLogger("main");

async function main(): Promise<void> {
  // Load and validate config
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    // Can't use logger if config fails (log level not set)
    process.stderr.write(`FATAL: Config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  setLogLevel(config.logLevel);
  log.info("Project Gecko starting", {
    liveTrading: config.liveTrading,
    killSwitch: config.killSwitch,
    maxPositionSize: config.maxPositionSize,
    maxTotalExposure: config.maxTotalExposure,
    minSpreadThreshold: config.minSpreadThreshold,
  });

  // Initialize feeds
  const binance = new BinanceFeed(config.binanceWsUrl);
  const coinbase = new CoinbaseFeed(config.coinbaseWsUrl);
  const polyRest = new PolymarketRestClient(config.polymarketClobUrl);
  const polyWs = new PolymarketWsFeed();
  const aggregator = new FeedAggregator(binance, coinbase, polyWs);

  // Initialize execution
  const positions = new PositionTracker();
  const orderBuilder = new OrderBuilder(config);
  const riskManager = new RiskManager(config, positions, aggregator);

  // Only initialize order signing if live trading is possible
  if (config.liveTrading) {
    try {
      await orderBuilder.initialize();
      log.info("Order builder ready for live trading");
    } catch (err) {
      log.error("Failed to initialize order builder, disabling live trading", {
        error: err instanceof Error ? err.message : String(err),
      });
      riskManager.activateKillSwitch("Order builder initialization failed");
    }
  }

  const executor = new OrderExecutor(config, orderBuilder, riskManager, positions, polyRest);

  // Initialize wallet monitor
  const walletMonitor = new WalletMonitor(config, riskManager);
  if (config.polygonRpcUrl) {
    await walletMonitor.start().catch((err) => {
      log.warn("Wallet monitor failed to start (balance monitoring disabled)", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Self-improvement engine
  const selfTuner = new SelfTuner(config);

  // Initialize monitoring
  const telegram = new TelegramNotifier(config.telegramBotToken, config.telegramChatId);
  const discord = new DiscordNotifier(config.discordWebhookUrl);
  const pnlTracker = new PnlTracker(positions);
  const healthChecker = new HealthChecker(binance, coinbase, polyWs, positions, riskManager, walletMonitor);
  const dailyReporter = new DailyReporter(config, pnlTracker, healthChecker, telegram, discord, selfTuner);

  // Position auto-closer (take-profit, stop-loss, max hold time)
  const positionCloser = new PositionCloser(config, positions, executor, aggregator, pnlTracker, telegram, selfTuner);

  // Opportunity handler: shared across all strategies
  const handleOpportunity = async (opp: Opportunity): Promise<void> => {
    log.info("Opportunity detected", {
      id: opp.id,
      strategy: opp.strategy,
      spread: opp.expectedSpread.toFixed(2),
      confidence: opp.confidence.toFixed(2),
    });

    dailyReporter.incrementOpportunities();

    // Check if this strategy has been auto-disabled by the self-tuner
    if (!selfTuner.isStrategyEnabled(opp.strategy)) {
      log.info("Opportunity skipped: strategy auto-disabled by self-tuner", {
        strategy: opp.strategy,
        id: opp.id,
      });
      return;
    }

    if (config.liveTrading) {
      const result = await executor.executeOpportunity(opp);
      if (result && (result.status === "filled" || result.status === "partial")) {
        const msg = `Trade executed: ${opp.strategy}\n${opp.description}\nFill: $${result.fillPrice} x ${result.fillSize}`;
        await Promise.all([
          telegram.sendAlert("Trade Executed", msg),
          discord.sendEmbed("Trade Executed", msg, 0x00ff00),
        ]);
      }
    }
  };

  // Initialize strategies
  const temporalArb = new TemporalArbStrategy(config, aggregator, polyRest, polyWs, selfTuner);
  temporalArb.setOpportunityHandler((opp) => {
    handleOpportunity(opp).catch((err) => {
      log.error("Error handling temporal-arb opportunity", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  const correlatedContracts = new CorrelatedContractsStrategy(config, polyRest);
  correlatedContracts.setOpportunityHandler((opp) => {
    handleOpportunity(opp).catch((err) => {
      log.error("Error handling correlated-contracts opportunity", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  // Start everything
  log.info("Starting feeds...");
  binance.start();
  coinbase.start();
  polyWs.start();

  log.info("Starting strategies...");
  await temporalArb.start();
  correlatedContracts.start();

  log.info("Starting monitoring...");
  healthChecker.start();
  dailyReporter.start();
  positionCloser.start();

  // Send startup notification
  const startupMsg = [
    `Mode: ${config.liveTrading ? "LIVE TRADING" : "SCAN ONLY"}`,
    `Max Position: $${config.maxPositionSize}`,
    `Max Exposure: $${config.maxTotalExposure}`,
    `Min Spread: ${config.minSpreadThreshold}%`,
    `Kill Switch: ${config.killSwitch ? "ACTIVE" : "inactive"}`,
    `Wallet Balance: $${walletMonitor.getBalance().toFixed(2)}`,
    `Open Positions: ${positions.getOpenPositionCount()} ($${positions.getTotalExposure().toFixed(2)} exposure)`,
  ].join("\n");

  await Promise.all([
    telegram.sendAlert("Gecko Bot Started", startupMsg),
    discord.sendEmbed("Gecko Bot Started", startupMsg, 0x0099ff),
  ]).catch((err) => {
    log.warn("Startup notification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  log.info("Project Gecko fully initialized and running");

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // Prevent double shutdown
    shuttingDown = true;
    log.info(`Shutdown signal received: ${signal}`);

    // Stop strategies first (no new trades)
    temporalArb.stop();
    correlatedContracts.stop();

    // Stop monitoring and position management
    positionCloser.stop();
    healthChecker.stop();
    dailyReporter.stop();
    walletMonitor.stop();
    clearInterval(heartbeatTimer);

    // Cancel all open orders on the exchange
    if (config.liveTrading) {
      await executor.cancelAllOrders().catch((err) => {
        log.error("Failed to cancel orders on shutdown", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Stop feeds and aggregator cleanup
    aggregator.stop();
    binance.stop();
    coinbase.stop();
    polyWs.stop();

    // Best-effort notification with timeout
    try {
      await Promise.race([
        Promise.all([
          telegram.sendAlert("Gecko Bot Stopped", `Shutdown: ${signal}`),
          discord.sendEmbed("Gecko Bot Stopped", `Shutdown: ${signal}`, 0xff0000),
        ]),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      log.warn("Shutdown notification failed");
    }

    log.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });

  // Unhandled rejection safety net: alert and continue (PM2 will restart if needed)
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled promise rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
    telegram.sendAlert("UNHANDLED REJECTION",
      reason instanceof Error ? reason.message : String(reason),
    ).catch(() => { /* best effort */ });
  });

  // Keep alive heartbeat
  const heartbeatTimer = setInterval(() => {
    log.debug("Heartbeat", {
      positions: positions.getOpenPositionCount(),
      exposure: positions.getTotalExposure(),
    });
  }, 300_000);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
