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
      }, { maxAttempts: 2, timeout: 5_000 });
    } catch (err) {
      log.error("Failed to send Discord message", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async sendEmbed(title: string, description: string, color?: number): Promise<void> {
    if (!this.enabled) return;

    try {
      await fetchWithRetry(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title,
            description,
            color: color ?? 0x00ff00,
            timestamp: new Date().toISOString(),
          }],
        }),
      }, { maxAttempts: 2, timeout: 5_000 });
    } catch (err) {
      log.error("Failed to send Discord embed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async sendTradeAlert(
    strategy: string,
    market: string,
    side: string,
    price: number,
    size: number,
    status: string,
  ): Promise<void> {
    const color = status === "filled" ? 0x00ff00 : status === "rejected" ? 0xff0000 : 0xffaa00;
    const description = [
      `**Strategy:** ${strategy}`,
      `**Market:** ${market}`,
      `**Side:** ${side} | **Price:** ${price.toFixed(4)} | **Size:** $${size.toFixed(2)}`,
    ].join("\n");

    await this.sendEmbed(`Trade ${status.toUpperCase()}`, description, color);
  }
}
