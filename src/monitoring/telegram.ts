import { createLogger } from "../core/logger.js";
import { fetchWithRetry } from "../utils/retry.js";

const log = createLogger("telegram");

export class TelegramNotifier {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly enabled: boolean;

  constructor(botToken: string, chatId: string) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.enabled = botToken.length > 0 && chatId.length > 0;

    if (!this.enabled) {
      log.warn("Telegram notifications disabled (missing token or chat ID)");
    }
  }

  async send(message: string): Promise<void> {
    if (!this.enabled) return;

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

    try {
      await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
          parse_mode: "HTML",
        }),
      });
    } catch (err) {
      log.error("Failed to send Telegram message", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async sendAlert(title: string, body: string): Promise<void> {
    const message = `<b>${this.escapeHtml(title)}</b>\n\n${this.escapeHtml(body)}`;
    await this.send(message);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
