import { createLogger } from "../core/logger.js";
import type { HealthStatus, FeedHealth } from "../core/types.js";
import type { BinanceFeed } from "../feeds/binance-ws.js";
import type { CoinbaseFeed } from "../feeds/coinbase-ws.js";
import type { PolymarketWsFeed } from "../feeds/polymarket-ws.js";
import type { PositionTracker } from "../execution/position-tracker.js";
import type { RiskManager } from "../execution/risk-manager.js";
import type { WalletMonitor } from "./wallet-monitor.js";

const log = createLogger("health-check");

export class HealthChecker {
  private readonly binance: BinanceFeed;
  private readonly coinbase: CoinbaseFeed;
  private readonly polyWs: PolymarketWsFeed;
  private readonly positions: PositionTracker;
  private readonly riskManager: RiskManager;
  private readonly walletMonitor: WalletMonitor | null;
  private readonly startTime: number;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    binance: BinanceFeed,
    coinbase: CoinbaseFeed,
    polyWs: PolymarketWsFeed,
    positions: PositionTracker,
    riskManager: RiskManager,
    walletMonitor?: WalletMonitor,
  ) {
    this.binance = binance;
    this.coinbase = coinbase;
    this.polyWs = polyWs;
    this.positions = positions;
    this.riskManager = riskManager;
    this.walletMonitor = walletMonitor ?? null;
    this.startTime = Date.now();
  }

  start(intervalMs = 60_000): void {
    this.timer = setInterval(() => {
      this.check();
    }, intervalMs);
    log.info("Health checker started", { intervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  check(): HealthStatus {
    const feeds: FeedHealth[] = [
      this.binance.getHealth(),
      this.coinbase.getHealth(),
      this.polyWs.getHealth(),
    ];

    const walletBalance = this.walletMonitor?.getBalance() ?? 0;

    const status: HealthStatus = {
      timestamp: Date.now(),
      feeds,
      positions: this.positions.getOpenPositionCount(),
      totalExposure: this.positions.getTotalExposure(),
      walletBalance,
      killSwitch: this.riskManager.isKillSwitchActive(),
      uptime: Date.now() - this.startTime,
    };

    for (const feed of feeds) {
      if (feed.status !== "connected") {
        log.warn("Feed unhealthy", {
          name: feed.name,
          status: feed.status,
          reconnectCount: feed.reconnectCount,
          error: feed.error,
        });
      }
    }

    log.debug("Health check complete", {
      feedsHealthy: feeds.every((f) => f.status === "connected"),
      positions: status.positions,
      exposure: status.totalExposure,
      walletBalance: walletBalance.toFixed(2),
      uptimeHours: (status.uptime / 3_600_000).toFixed(1),
    });

    return status;
  }
}
