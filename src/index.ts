import { loadConfig } from "./core/config.js";
import { createLogger, setLogLevel } from "./core/logger.js";
import { BinanceFeed } from "./feeds/binance-ws.js";
import { CoinbaseFeed } from "./feeds/coinbase-ws.js";
import { PolymarketRestClient } from "./feeds/polymarket-rest.js";
import { PolymarketFeed } from "./feeds/polymarket-ws.js";
import { FeedAggregator } from "./feeds/feed-aggregator.js";
import { TemporalArbStrategy } from "./strategies/temporal-arb.js";
import { CorrelatedContractsStrategy } from "./strategies/correlated-contracts.js";
import { OrderBuilder } from "./execution/order-builder.js";
import { OrderExecutor } from "./execution/order-executor.js";
import { RiskManager } from "./execution/risk-manager.js";
import { PositionTracker } from "./execution/position-tracker.js";
import { TelegramNotifier } from "./monitoring/telegram.js";
import { DiscordNotifier } from "./monitoring/discord.js";
import { PnlTracker } from "./monitoring/pnl-tracker.js";
import { HealthChecker } from "./monitoring/health-check.js";
import { DailyReporter } from "./monitoring/daily-report.js";
import type { Opportunity } from "./core/types.js";

const log = createLogger("main");

async function main(): Promise<void> {
  // Load and validate config
  const config = loadConfig();
  setLogLevel(config.logLevel);

  log.info("Project Gecko starting", {
    liveTrading: config.liveTrading,
    killSwitch: config.killSwitch,
    maxPositionSize: config.maxPositionSize,
    maxTotalExposure: config.maxTotalExposure,
    minSpreadThreshold: config.minSpreadThreshold,
  });

  // -- Initialize core components --

  const aggregator = new FeedAggregator();
  const polymarketRest = new PolymarketRestClient(config.polymarketClobUrl);
  const positionTracker = new PositionTracker();
  const riskManager = new RiskManager(config, positionTracker);

  // -- Initialize execution --

  const orderBuilder = new OrderBuilder(config);
  try {
    await orderBuilder.initialize();
  } catch (err) {
    log.error("Failed to initialize order builder", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Continue in scan-only mode
    log.warn("Running in scan-only mode due to order builder initialization failure");
  }

  const orderExecutor = new OrderExecutor(orderBuilder, riskManager, positionTracker);

  // -- Initialize monitoring --

  const telegram = new TelegramNotifier(config.telegramBotToken, config.telegramChatId);
  const discord = new DiscordNotifier(config.discordWebhookUrl);
  const pnlTracker = new PnlTracker(positionTracker);
  const healthChecker = new HealthChecker(positionTracker, riskManager);
  const dailyReporter = new DailyReporter(pnlTracker, positionTracker, telegram, discord);

  // -- Initialize feeds --

  const binanceFeed = new BinanceFeed(config.binanceWsUrl);
  const coinbaseFeed = new CoinbaseFeed(config.coinbaseWsUrl);
  const polymarketFeed = new PolymarketFeed();

  // Wire price handlers
  binanceFeed.setPriceHandler((price) => {
    aggregator.updateSpotPrice(price);
  });

  coinbaseFeed.setPriceHandler((price) => {
    aggregator.updateSpotPrice(price);
  });

  polymarketFeed.setPriceHandler((update) => {
    aggregator.updateContractPrice(update);
  });

  // Register feed health providers
  healthChecker.addFeedProvider(() => binanceFeed.getHealth());
  healthChecker.addFeedProvider(() => coinbaseFeed.getHealth());
  healthChecker.addFeedProvider(() => polymarketFeed.getHealth());

  // -- Initialize strategies --

  const temporalArb = new TemporalArbStrategy(config, aggregator, polymarketRest);
  const correlatedContracts = new CorrelatedContractsStrategy(config, polymarketRest);

  // Wire opportunity handler (shared by all strategies)
  const handleOpportunity = async (opportunity: Opportunity): Promise<void> => {
    dailyReporter.incrementOpportunities();

    log.info("Opportunity detected", {
      id: opportunity.id,
      strategy: opportunity.strategy,
      spread: opportunity.expectedSpread.toFixed(2) + "%",
      confidence: opportunity.confidence.toFixed(3),
    });

    // Execute if live trading is enabled
    if (config.liveTrading) {
      const feedHealths = healthChecker.getFeedHealths();
      const result = await orderExecutor.executeOpportunity(opportunity, feedHealths);

      if (result && (result.status === "filled" || result.status === "partial")) {
        await telegram.sendTradeAlert(
          opportunity.strategy,
          opportunity.description,
          opportunity.params.side,
          result.fillPrice,
          result.fillSize,
          result.status,
        );
        await discord.sendTradeAlert(
          opportunity.strategy,
          opportunity.description,
          opportunity.params.side,
          result.fillPrice,
          result.fillSize,
          result.status,
        );
      }
    }
  };

  temporalArb.setOpportunityHandler((opp) => {
    handleOpportunity(opp).catch((err) => {
      log.error("Error handling temporal arb opportunity", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  correlatedContracts.setOpportunityHandler((opp) => {
    handleOpportunity(opp).catch((err) => {
      log.error("Error handling correlated contracts opportunity", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  // -- Start everything --

  log.info("Starting data feeds");
  binanceFeed.start();
  coinbaseFeed.start();
  polymarketFeed.start();

  log.info("Starting strategies");
  temporalArb.start();
  correlatedContracts.start();

  log.info("Starting monitoring");
  dailyReporter.start();

  // Health check every 60 seconds
  const healthInterval = setInterval(() => {
    healthChecker.check().catch((err) => {
      log.error("Health check error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, 60_000);

  // P&L summary every 5 minutes
  const pnlInterval = setInterval(() => {
    pnlTracker.logSummary();
  }, 5 * 60_000);

  // Startup notification
  await telegram.sendAlert("Project Gecko Started", [
    `Mode: ${config.liveTrading ? "LIVE TRADING" : "SCAN ONLY"}`,
    `Max position: $${config.maxPositionSize}`,
    `Max exposure: $${config.maxTotalExposure}`,
    `Min spread: ${config.minSpreadThreshold}%`,
  ].join("\n"));

  log.info("Project Gecko running", {
    mode: config.liveTrading ? "live" : "scan-only",
  });

  // -- Graceful shutdown --

  const shutdown = async (signal: string): Promise<void> => {
    log.info("Shutdown signal received", { signal });

    temporalArb.stop();
    correlatedContracts.stop();
    dailyReporter.stop();
    clearInterval(healthInterval);
    clearInterval(pnlInterval);

    binanceFeed.stop();
    coinbaseFeed.stop();
    polymarketFeed.stop();

    await telegram.sendAlert("Project Gecko Stopped", `Signal: ${signal}`);

    log.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });

  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled promise rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });

  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception", { error: err.message, stack: err.stack });
    shutdown("uncaughtException").catch(() => process.exit(1));
  });
}

main().catch((err) => {
  const log = createLogger("main");
  log.error("Fatal startup error", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
