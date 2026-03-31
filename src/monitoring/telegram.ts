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
      log.warn("Telegram notifications disabled (missing bot token or chat ID)");
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
      }, { maxAttempts: 2, timeout: 5_000 });
    } catch (err) {
      log.error("Failed to send Telegram message", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async sendAlert(title: string, details: string): Promise<void> {
    const msg = `<b>${this.escapeHtml(title)}</b>\n${this.escapeHtml(details)}`;
    await this.send(msg);
  }

  async sendTradeAlert(
    strategy: string,
    market: string,
    side: string,
    price: number,
    size: number,
    status: string,
  ): Promise<void> {
    const msg = [
      `<b>Trade ${status.toUpperCase()}</b>`,
      `Strategy: ${this.escapeHtml(strategy)}`,
      `Market: ${this.escapeHtml(market)}`,
      `Side: ${side} | Price: ${price.toFixed(4)} | Size: $${size.toFixed(2)}`,
    ].join("\n");
    await this.send(msg);
  }

  async sendKillSwitchAlert(reason: string): Promise<void> {
    const msg = `<b>KILL SWITCH ACTIVATED</b>\nReason: ${this.escapeHtml(reason)}`;
    await this.send(msg);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}
