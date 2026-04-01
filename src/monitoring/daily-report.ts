import { createLogger } from "../core/logger.js";
import type { AppConfig, DailySummary } from "../core/types.js";
import type { PnlTracker } from "./pnl-tracker.js";
import type { HealthChecker } from "./health-check.js";
import type { TelegramNotifier } from "./telegram.js";
import type { SelfTuner } from "../strategies/self-tuner.js";
import type { DiscordNotifier } from "./discord.js";
import { appendJsonl } from "../utils/persistence.js";
import { isoDate } from "../utils/time.js";

const log = createLogger("daily-report");

export class DailyReporter {
  private readonly config: AppConfig;
  private readonly pnl: PnlTracker;
  private readonly health: HealthChecker;
  private readonly telegram: TelegramNotifier;
  private readonly discord: DiscordNotifier;
  private readonly selfTuner: SelfTuner | null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReportDate = "";
  private opportunityCount = 0;

  constructor(
    config: AppConfig,
    pnl: PnlTracker,
    health: HealthChecker,
    telegram: TelegramNotifier,
    discord: DiscordNotifier,
    selfTuner?: SelfTuner,
  ) {
    this.config = config;
    this.pnl = pnl;
    this.health = health;
    this.telegram = telegram;
    this.discord = discord;
    this.selfTuner = selfTuner ?? null;
  }

  incrementOpportunities(): void {
    this.opportunityCount++;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.checkMidnight().catch((err) => {
        log.error("Daily report error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 60_000);

    this.lastReportDate = isoDate();
    log.info("Daily reporter started (UTC midnight)");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async checkMidnight(): Promise<void> {
    const today = isoDate();
    if (today === this.lastReportDate) return;

    this.lastReportDate = today;
    await this.sendReport();

    // Reset daily counters after report
    this.opportunityCount = 0;
  }

  async sendReport(): Promise<void> {
    const summary = this.pnl.getSummary();
    const healthStatus = this.health.check();

    const feedStatus = healthStatus.feeds
      .map((f) => `${f.name}: ${f.status} (reconnects: ${f.reconnectCount})`)
      .join("\n");

    const report = [
      `Daily Report (UTC) - ${isoDate()}`,
      "---",
      summary,
      "---",
      "Feed Status:",
      feedStatus,
      "---",
      `Kill Switch: ${healthStatus.killSwitch ? "ACTIVE" : "inactive"}`,
      `Uptime: ${(healthStatus.uptime / 3_600_000).toFixed(1)} hours`,
      `Opportunities scanned: ${this.opportunityCount}`,
      ...(this.selfTuner ? ["---", "Self-Tuner:", this.selfTuner.getSummary()] : []),
    ].join("\n");

    log.info("Sending daily report");

    await Promise.all([
      this.telegram.sendAlert("Gecko Daily Report", report),
      this.discord.sendEmbed("Gecko Daily Report", report),
    ]).catch((err) => {
      log.error("Failed to send daily report notifications", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Persist complete summary
    const dailySummary: DailySummary = {
      date: isoDate(),
      totalTrades: this.pnl.getTradeCount(),
      winningTrades: this.pnl.getWinCount(),
      losingTrades: this.pnl.getLossCount(),
      totalPnl: this.pnl.getTotalPnl(),
      totalFees: this.pnl.getTotalFees(),
      netPnl: this.pnl.getNetPnl(),
      maxDrawdown: 0, // TODO: track intra-day drawdown
      opportunities: this.opportunityCount,
      strategies: {
        "temporal-arb": { enabled: true, lastScan: Date.now(), opportunitiesFound: 0, tradesExecuted: 0 },
        "cross-platform": { enabled: false, lastScan: 0, opportunitiesFound: 0, tradesExecuted: 0 },
        "correlated-contracts": { enabled: true, lastScan: Date.now(), opportunitiesFound: 0, tradesExecuted: 0 },
      },
    };
    appendJsonl("data/daily-summary.jsonl", dailySummary);
  }
}
