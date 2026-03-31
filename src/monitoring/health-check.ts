import { createLogger } from "../core/logger.js";
import type { FeedHealth, HealthStatus } from "../core/types.js";
import type { PositionTracker } from "../execution/position-tracker.js";
import type { RiskManager } from "../execution/risk-manager.js";

const log = createLogger("health-check");

export class HealthChecker {
  private readonly positionTracker: PositionTracker;
  private readonly riskManager: RiskManager;
  private readonly startTime: number;

  private feedProviders: (() => FeedHealth)[] = [];
  private walletBalanceProvider: (() => Promise<number>) | null = null;

  constructor(positionTracker: PositionTracker, riskManager: RiskManager) {
    this.positionTracker = positionTracker;
    this.riskManager = riskManager;
    this.startTime = Date.now();
  }

  addFeedProvider(provider: () => FeedHealth): void {
    this.feedProviders.push(provider);
  }

  setWalletBalanceProvider(provider: () => Promise<number>): void {
    this.walletBalanceProvider = provider;
  }

  async getStatus(): Promise<HealthStatus> {
    const feeds = this.feedProviders.map((p) => p());
    let walletBalance = 0;

    if (this.walletBalanceProvider) {
      try {
        walletBalance = await this.walletBalanceProvider();
      } catch (err) {
        log.warn("Failed to get wallet balance", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      timestamp: Date.now(),
      feeds,
      positions: this.positionTracker.getOpenPositionCount(),
      totalExposure: this.positionTracker.getTotalExposure(),
      walletBalance,
      killSwitch: this.riskManager.isKillSwitchActive(),
      uptime: Date.now() - this.startTime,
    };
  }

  getFeedHealths(): FeedHealth[] {
    return this.feedProviders.map((p) => p());
  }

  async check(): Promise<void> {
    const status = await this.getStatus();

    const unhealthyFeeds = status.feeds.filter(
      (f) => f.status !== "connected",
    );

    if (unhealthyFeeds.length > 0) {
      log.warn("Unhealthy feeds detected", {
        feeds: unhealthyFeeds.map((f) => ({ name: f.name, status: f.status })),
      });
    }

    if (status.killSwitch) {
      log.warn("Kill switch is active");
    }

    log.info("Health check complete", {
      feeds: status.feeds.length,
      unhealthy: unhealthyFeeds.length,
      positions: status.positions,
      exposure: status.totalExposure,
      walletBalance: status.walletBalance,
      uptimeMinutes: Math.round(status.uptime / 60_000),
    });
  }
}
