import { createLogger } from "../core/logger.js";
import type { AppConfig, Opportunity, TradeParams } from "../core/types.js";
import type { PositionTracker } from "./position-tracker.js";
import type { FeedAggregator } from "../feeds/feed-aggregator.js";

const log = createLogger("risk-manager");

export interface RiskCheckResult {
  readonly allowed: boolean;
  readonly reason: string;
}

export class RiskManager {
  private readonly config: AppConfig;
  private readonly positions: PositionTracker;
  private readonly aggregator: FeedAggregator;
  private killSwitchActive: boolean;

  constructor(config: AppConfig, positions: PositionTracker, aggregator: FeedAggregator) {
    this.config = config;
    this.positions = positions;
    this.aggregator = aggregator;
    this.killSwitchActive = config.killSwitch;
  }

  checkTrade(opportunity: Opportunity): RiskCheckResult {
    const params = opportunity.params;

    // 1. Kill switch
    if (this.killSwitchActive) {
      return this.deny("Kill switch is active");
    }

    // 2. Live trading must be enabled
    if (!this.config.liveTrading) {
      return this.deny("Live trading is disabled (LIVE_TRADING=false)");
    }

    // 3. Feed health: all WebSocket feeds must be connected
    if (!this.aggregator.areFeedsHealthy()) {
      return this.deny("One or more feeds disconnected for >30s");
    }

    // 4. Position size limit
    if (params.size > this.config.maxPositionSize) {
      return this.deny(`Position size $${params.size} exceeds max $${this.config.maxPositionSize}`);
    }

    // 5. Total exposure limit
    const currentExposure = this.positions.getTotalExposure();
    if (currentExposure + params.size > this.config.maxTotalExposure) {
      return this.deny(
        `Total exposure would be $${currentExposure + params.size}, ` +
        `exceeds max $${this.config.maxTotalExposure}`
      );
    }

    // 6. Max open positions
    const openCount = this.positions.getOpenPositionCount();
    if (openCount >= this.config.maxOpenPositions) {
      return this.deny(`Already have ${openCount} open positions (max ${this.config.maxOpenPositions})`);
    }

    // 7. Minimum liquidity check (deferred to order executor which checks order book)

    // 8. Price sanity check
    if (params.price <= 0 || params.price >= 1) {
      return this.deny(`Invalid price: ${params.price}`);
    }

    log.info("Risk check passed", {
      opportunityId: opportunity.id,
      size: params.size,
      currentExposure,
      openPositions: openCount,
    });

    return { allowed: true, reason: "All checks passed" };
  }

  activateKillSwitch(reason: string): void {
    this.killSwitchActive = true;
    log.error("KILL SWITCH ACTIVATED", { reason });
  }

  deactivateKillSwitch(): void {
    this.killSwitchActive = false;
    log.info("Kill switch deactivated");
  }

  isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  private deny(reason: string): RiskCheckResult {
    log.warn("Risk check failed", { reason });
    return { allowed: false, reason };
  }
}
