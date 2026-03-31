import { createLogger } from "../core/logger.js";
import type { AppConfig, Opportunity, FeedHealth } from "../core/types.js";
import type { PositionTracker } from "./position-tracker.js";

const log = createLogger("risk-manager");

// Feed disconnection threshold: pause trading if any feed down >30s
const FEED_DISCONNECT_THRESHOLD = 30_000;

export interface RiskCheckResult {
  readonly allowed: boolean;
  readonly reason: string;
}

export class RiskManager {
  private readonly config: AppConfig;
  private readonly positionTracker: PositionTracker;
  private killSwitchActive: boolean;
  private startingBalance: number | null = null;

  constructor(config: AppConfig, positionTracker: PositionTracker) {
    this.config = config;
    this.positionTracker = positionTracker;
    this.killSwitchActive = config.killSwitch;
  }

  setStartingBalance(balance: number): void {
    this.startingBalance = balance;
  }

  activateKillSwitch(reason: string): void {
    this.killSwitchActive = true;
    log.error("KILL SWITCH ACTIVATED", { reason });
  }

  isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  deactivateKillSwitch(): void {
    this.killSwitchActive = false;
    log.warn("Kill switch deactivated manually");
  }

  // Run all risk checks before executing a trade
  checkTrade(opportunity: Opportunity, feedHealths: readonly FeedHealth[]): RiskCheckResult {
    // 1. Kill switch
    if (this.killSwitchActive) {
      const result = { allowed: false, reason: "Kill switch is active" };
      log.warn("Risk check FAILED: kill switch", { opportunityId: opportunity.id });
      return result;
    }

    // 2. Live trading mode
    if (!this.config.liveTrading) {
      const result = { allowed: false, reason: "LIVE_TRADING is false (scan-only mode)" };
      log.info("Risk check: scan-only mode", { opportunityId: opportunity.id });
      return result;
    }

    // 3. Position size limit
    if (opportunity.params.size > this.config.maxPositionSize) {
      const result = {
        allowed: false,
        reason: `Position size ${opportunity.params.size} exceeds max ${this.config.maxPositionSize}`,
      };
      log.warn("Risk check FAILED: position size", { opportunityId: opportunity.id });
      return result;
    }

    // 4. Total exposure limit
    const currentExposure = this.positionTracker.getTotalExposure();
    if (currentExposure + opportunity.params.size > this.config.maxTotalExposure) {
      const result = {
        allowed: false,
        reason: `Total exposure ${currentExposure + opportunity.params.size} would exceed max ${this.config.maxTotalExposure}`,
      };
      log.warn("Risk check FAILED: total exposure", {
        opportunityId: opportunity.id,
        currentExposure,
        additionalSize: opportunity.params.size,
      });
      return result;
    }

    // 5. Max open positions
    const openPositions = this.positionTracker.getOpenPositionCount();
    if (openPositions >= this.config.maxOpenPositions) {
      const result = {
        allowed: false,
        reason: `Open positions ${openPositions} at max ${this.config.maxOpenPositions}`,
      };
      log.warn("Risk check FAILED: max positions", { opportunityId: opportunity.id, openPositions });
      return result;
    }

    // 6. Feed health check
    const now = Date.now();
    for (const feed of feedHealths) {
      if (feed.status === "disconnected" || feed.status === "error") {
        const downTime = now - feed.lastMessage;
        if (downTime > FEED_DISCONNECT_THRESHOLD) {
          const result = {
            allowed: false,
            reason: `Feed "${feed.name}" disconnected for ${Math.round(downTime / 1000)}s`,
          };
          log.warn("Risk check FAILED: feed disconnected", {
            opportunityId: opportunity.id,
            feed: feed.name,
            downTime,
          });
          return result;
        }
      }
    }

    // 7. Minimum liquidity (checked at strategy level but double-check here)
    // This would require order book data; we trust the strategy's check for now

    log.info("Risk check PASSED", {
      opportunityId: opportunity.id,
      size: opportunity.params.size,
      currentExposure,
      openPositions,
    });

    return { allowed: true, reason: "All checks passed" };
  }

  // Check wallet balance and activate kill switch if too low
  checkWalletBalance(currentBalance: number): void {
    if (this.startingBalance === null) {
      this.startingBalance = currentBalance;
      return;
    }

    const threshold = this.startingBalance * 0.10;
    if (currentBalance < threshold) {
      this.activateKillSwitch(
        `Wallet balance ${currentBalance.toFixed(2)} below 10% of starting balance ${this.startingBalance.toFixed(2)}`,
      );
    }
  }
}
