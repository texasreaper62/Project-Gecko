// RiskManager: the gate every order must pass before submission.
//
// Checks in order:
//   1. Kill switch (manual halt)
//   2. Live trading enabled
//   3. Daily loss limit not tripped
//   4. PDT counter has headroom (defensive even post-rule-change)
//   5. Position count within engine caps (equities / options separately)
//   6. Trade size is finite and positive
//   7. Buying power available (cash for equities, premium for options)
//   8. Symbol-specific dedup (no second position in same instrument)
//
// Owns the kill switch state. Once tripped (manual call or catastrophic
// failure), only deactivateKillSwitch() can clear it.

import { createLogger } from "../core/logger.js";
import type { AppConfig, AccountSnapshot, TradeSignal } from "../core/types.js";
import type { DailyStop } from "./daily-stop.js";
import type { PdtTracker } from "./pdt-tracker.js";
import type { PositionTracker } from "../execution/position-tracker.js";

const log = createLogger("risk-manager");

export interface RiskCheckResult {
  readonly allowed: boolean;
  readonly reason: string;
}

export class RiskManager {
  private killSwitchActive: boolean;

  constructor(
    private readonly config: AppConfig,
    private readonly dailyStop: DailyStop,
    private readonly pdt: PdtTracker,
    private readonly positions: PositionTracker,
  ) {
    this.killSwitchActive = config.killSwitch;
  }

  check(signal: TradeSignal, account: AccountSnapshot): RiskCheckResult {
    if (this.killSwitchActive) return deny("Kill switch active");
    if (!this.config.liveTrading) return deny("LIVE_TRADING=false");

    if (this.dailyStop.isHalted()) return deny("Daily loss limit tripped");

    if (this.pdt.wouldExceedLimit()) {
      return deny(`PDT counter at limit (${this.pdt.countInRollingWindow()}/${this.config.maxDayTrades} in rolling 5 days)`);
    }

    const isEquity = signal.order.instrument.assetClass === "equity";
    const equityOpen = this.positions.countByAssetClass("equity");
    const optionOpen = this.positions.countByAssetClass("option");

    if (isEquity && equityOpen >= this.config.maxConcurrentEquityPositions) {
      return deny(`Equity position cap reached (${equityOpen}/${this.config.maxConcurrentEquityPositions})`);
    }
    if (!isEquity && optionOpen >= this.config.maxConcurrentOptionPositions) {
      return deny(`Option position cap reached (${optionOpen}/${this.config.maxConcurrentOptionPositions})`);
    }

    if (
      !Number.isFinite(signal.order.quantity) ||
      signal.order.quantity <= 0 ||
      !Number.isFinite(signal.riskUsd) ||
      signal.riskUsd <= 0
    ) {
      return deny(`Invalid signal: qty=${signal.order.quantity} riskUsd=${signal.riskUsd}`);
    }

    // Buying power check: equity uses notional, option uses premium.
    const notional = isEquity
      ? signal.order.quantity * (signal.order.limitPrice ?? 0)
      : signal.order.quantity * (signal.order.limitPrice ?? 0) * 100;

    if (notional > account.dayTradeBuyingPower) {
      return deny(`Notional $${notional.toFixed(2)} exceeds day-trade BP $${account.dayTradeBuyingPower.toFixed(2)}`);
    }

    if (this.positions.hasInstrument(signal.order.instrument)) {
      return deny("Already have a position in this instrument");
    }

    log.info("Risk check passed", {
      signalId: signal.id,
      strategy: signal.strategy,
      qty: signal.order.quantity,
      notional: notional.toFixed(2),
      equityOpen,
      optionOpen,
    });
    return { allowed: true, reason: "ok" };
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
}

function deny(reason: string): RiskCheckResult {
  log.warn("Risk check denied", { reason });
  return { allowed: false, reason };
}
