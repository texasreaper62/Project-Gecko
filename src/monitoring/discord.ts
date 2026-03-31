import { createLogger } from "../core/logger.js";
import { fetchWithRetry } from "../utils/retry.js";

const log = createLogger("discord");

export class DiscordNotifier {
  private readonly webhookUrl: string;
  private readonly enabled: boolean;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
    this.enabled = webhookUrl.length > 0;

    if (!this.enabled) {
      log.warn("Discord notifications disabled (missing webhook URL)");
    }
  }

  async send(content: string): Promise<void> {
    if (!this.enabled) return;

    try {
      await fetchWithRetry(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
    } catch (err) {
      log.error("Failed to send Discord message", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async sendEmbed(title: string, description: string, color = 0x00ff00): Promise<void> {
    if (!this.enabled) return;

    try {
      await fetchWithRetry(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title,
            description,
            color,
            timestamp: new Date().toISOString(),
          }],
        }),
      });
    } catch (err) {
      log.error("Failed to send Discord embed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
