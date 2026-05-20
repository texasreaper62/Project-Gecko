// Daily loss limit. Halts all new trades for the rest of the trading day
// once realized + unrealized P&L crosses below -DAILY_LOSS_LIMIT_PCT of
// starting equity.
//
// Resets each trading day from the morning's starting equity snapshot.

import { createLogger } from "../core/logger.js";

const log = createLogger("daily-stop");

export class DailyStop {
  private startingEquity = 0;
  private dailyLossLimitPct = 0;
  private halted = false;
  private currentDate: string | null = null;

  constructor(dailyLossLimitPct: number) {
    this.dailyLossLimitPct = dailyLossLimitPct;
  }

  // Call this at session open (or whenever the trading day rolls over)
  // with the account's starting equity for the day.
  resetForDay(date: string, startingEquity: number): void {
    this.currentDate = date;
    this.startingEquity = startingEquity;
    this.halted = false;
    log.info("Daily stop armed", {
      date,
      startingEquity,
      thresholdPct: this.dailyLossLimitPct,
      thresholdUsd: -(startingEquity * this.dailyLossLimitPct / 100),
    });
  }

  // Returns true if a new trade should be blocked.
  isHalted(): boolean {
    return this.halted;
  }

  // Evaluate current equity against the day's threshold. Trips the halt
  // on first crossing.
  update(currentEquity: number): void {
    if (this.startingEquity <= 0) return;
    if (this.halted) return;

    const drawdownPct = (currentEquity - this.startingEquity) / this.startingEquity * 100;
    if (drawdownPct <= -this.dailyLossLimitPct) {
      this.halted = true;
      log.error("DAILY STOP TRIPPED", {
        startingEquity: this.startingEquity,
        currentEquity,
        drawdownPct: drawdownPct.toFixed(2),
        thresholdPct: this.dailyLossLimitPct,
      });
    }
  }

  getDate(): string | null {
    return this.currentDate;
  }
}
