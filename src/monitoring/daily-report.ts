import { createLogger } from "../core/logger.js";
import { isoDate } from "../utils/time.js";
import { appendJsonl } from "../utils/persistence.js";
import type { DailySummary, StrategyState } from "../core/types.js";
import type { PnlTracker } from "./pnl-tracker.js";
import type { PositionTracker } from "../execution/position-tracker.js";
import type { TelegramNotifier } from "./telegram.js";
import type { DiscordNotifier } from "./discord.js";

const log = createLogger("daily-report");

export class DailyReporter {
  private readonly pnlTracker: PnlTracker;
  private readonly positionTracker: PositionTracker;
  private readonly telegram: TelegramNotifier;
  private readonly discord: DiscordNotifier;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private opportunityCount = 0;

  constructor(
    pnlTracker: PnlTracker,
    positionTracker: PositionTracker,
    telegram: TelegramNotifier,
    discord: DiscordNotifier,
  ) {
    this.pnlTracker = pnlTracker;
    this.positionTracker = positionTracker;
    this.telegram = telegram;
    this.discord = discord;
  }

  incrementOpportunities(): void {
    this.opportunityCount++;
  }

  start(): void {
    this.scheduleNextReport();
    log.info("Daily reporter started");
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info("Daily reporter stopped");
  }

  private scheduleNextReport(): void {
    // Calculate ms until next midnight UTC
    const now = new Date();
    const tomorrow = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0, 0, 0, 0,
    ));
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    this.timer = setTimeout(() => {
      this.generateReport().catch((err) => {
        log.error("Failed to generate daily report", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      this.scheduleNextReport();
    }, msUntilMidnight);

    log.debug("Next daily report scheduled", {
      msUntilMidnight,
      nextReport: tomorrow.toISOString(),
    });
  }

  async generateReport(): Promise<void> {
    const summary: DailySummary = {
      date: isoDate(),
      totalTrades: this.positionTracker.getTradeCount(),
      winningTrades: 0, // Would need trade-level tracking to compute
      losingTrades: 0,
      totalPnl: this.pnlTracker.getTotalPnl(),
      totalFees: this.pnlTracker.getTotalFees(),
      netPnl: this.pnlTracker.getNetPnl(),
      maxDrawdown: 0, // Would need equity curve tracking
      opportunities: this.opportunityCount,
      strategies: {
        "temporal-arb": { enabled: true, lastScan: 0, opportunitiesFound: 0, tradesExecuted: 0 },
        "cross-platform": { enabled: false, lastScan: 0, opportunitiesFound: 0, tradesExecuted: 0 },
        "correlated-contracts": { enabled: true, lastScan: 0, opportunitiesFound: 0, tradesExecuted: 0 },
      },
    };

    // Persist
    appendJsonl("data/daily-summary.jsonl", summary);

    // Build report text
    const report = [
      `Daily Report - ${summary.date}`,
      `Trades: ${summary.totalTrades}`,
      `Net P&L: $${summary.netPnl.toFixed(4)}`,
      `Fees: $${summary.totalFees.toFixed(4)}`,
      `Opportunities: ${summary.opportunities}`,
      `Open positions: ${this.positionTracker.getOpenPositionCount()}`,
      `Exposure: $${this.positionTracker.getTotalExposure().toFixed(2)}`,
    ].join("\n");

    log.info("Daily report generated", { summary });

    // Send notifications
    await this.telegram.sendAlert("Daily Report", report);
    await this.discord.sendEmbed(`Daily Report - ${summary.date}`, report, 0x0099ff);

    // Reset daily counters
    this.opportunityCount = 0;
  }
}
