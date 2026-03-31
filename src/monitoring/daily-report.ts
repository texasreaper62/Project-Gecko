import { createLogger } from "../core/logger.js";
import type { AppConfig, DailySummary } from "../core/types.js";
import type { PnlTracker } from "./pnl-tracker.js";
import type { HealthChecker } from "./health-check.js";
import type { TelegramNotifier } from "./telegram.js";
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

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReportDate = "";

  constructor(
    config: AppConfig,
    pnl: PnlTracker,
    health: HealthChecker,
    telegram: TelegramNotifier,
    discord: DiscordNotifier,
  ) {
    this.config = config;
    this.pnl = pnl;
    this.health = health;
    this.telegram = telegram;
    this.discord = discord;
  }

  start(): void {
    // Check every minute if we've crossed midnight UTC
    this.timer = setInterval(() => {
      this.checkMidnight().catch((err) => {
        log.error("Daily report error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 60_000);

    this.lastReportDate = isoDate();
    log.info("Daily reporter started");
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

    // New day! Send report for previous day
    this.lastReportDate = today;
    await this.sendReport();
  }

  async sendReport(): Promise<void> {
    const summary = this.pnl.getSummary();
    const healthStatus = this.health.check();

    const feedStatus = healthStatus.feeds
      .map((f) => `${f.name}: ${f.status} (reconnects: ${f.reconnectCount})`)
      .join("\n");

    const report = [
      `Daily Report - ${isoDate()}`,
      "---",
      summary,
      "---",
      "Feed Status:",
      feedStatus,
      "---",
      `Kill Switch: ${healthStatus.killSwitch ? "ACTIVE" : "inactive"}`,
      `Uptime: ${(healthStatus.uptime / 3_600_000).toFixed(1)} hours`,
    ].join("\n");

    log.info("Sending daily report");

    await Promise.all([
      this.telegram.sendAlert("Gecko Daily Report", report),
      this.discord.sendEmbed("Gecko Daily Report", report),
    ]);

    // Persist summary
    const dailySummary: Partial<DailySummary> = {
      date: isoDate(),
      totalPnl: this.pnl.getTotalPnl(),
      netPnl: this.pnl.getNetPnl(),
    };
    appendJsonl("data/daily-summary.jsonl", dailySummary);
  }
}
