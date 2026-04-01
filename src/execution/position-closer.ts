import { createLogger } from "../core/logger.js";
import type { AppConfig, Position } from "../core/types.js";
import type { PositionTracker } from "./position-tracker.js";
import type { FeedAggregator } from "../feeds/feed-aggregator.js";
import type { PnlTracker } from "../monitoring/pnl-tracker.js";
import type { TelegramNotifier } from "../monitoring/telegram.js";

const log = createLogger("position-closer");

// Check positions every 5 seconds
const CHECK_INTERVAL = 5_000;
// Close positions 30 seconds before contract expiry
const EXPIRY_BUFFER_MS = 30_000;
// Take profit at 15% gain
const TAKE_PROFIT_PERCENT = 15;
// Stop loss at -10% loss
const STOP_LOSS_PERCENT = -10;

export class PositionCloser {
  private readonly config: AppConfig;
  private readonly positions: PositionTracker;
  private readonly aggregator: FeedAggregator;
  private readonly pnlTracker: PnlTracker;
  private readonly telegram: TelegramNotifier;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: AppConfig,
    positions: PositionTracker,
    aggregator: FeedAggregator,
    pnlTracker: PnlTracker,
    telegram: TelegramNotifier,
  ) {
    this.config = config;
    this.positions = positions;
    this.aggregator = aggregator;
    this.pnlTracker = pnlTracker;
    this.telegram = telegram;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.checkPositions().catch((err) => {
        log.error("Position check error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, CHECK_INTERVAL);
    log.info("Position closer started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async checkPositions(): Promise<void> {
    const openPositions = this.positions.getPositions();
    if (openPositions.length === 0) return;

    for (const pos of openPositions) {
      // Update current price from aggregator
      const currentPrice = this.aggregator.getTokenPrice(pos.tokenId);
      if (currentPrice !== null) {
        this.positions.updatePrice(pos.tokenId, currentPrice);
      }

      const closeReason = this.shouldClose(pos);
      if (closeReason) {
        await this.closePosition(pos, closeReason);
      }
    }
  }

  private shouldClose(pos: Position): string | null {
    // 1. Check if position is near expiry (contract about to settle)
    // We don't have expiry info stored on position, so we skip this for now
    // and rely on contract settlement

    // 2. Take profit
    const pnlPercent = this.pnlPercent(pos);
    if (pnlPercent >= TAKE_PROFIT_PERCENT) {
      return `Take profit: ${pnlPercent.toFixed(1)}% gain`;
    }

    // 3. Stop loss
    if (pnlPercent <= STOP_LOSS_PERCENT) {
      return `Stop loss: ${pnlPercent.toFixed(1)}% loss`;
    }

    // 4. Position held too long (over 30 minutes for short-term arb)
    const holdTimeMs = Date.now() - pos.openTimestamp;
    if (holdTimeMs > 30 * 60 * 1000) {
      return `Max hold time exceeded: ${(holdTimeMs / 60_000).toFixed(0)}min`;
    }

    return null;
  }

  private pnlPercent(pos: Position): number {
    if (pos.entryPrice === 0) return 0;
    const diff = pos.side === "BUY"
      ? pos.currentPrice - pos.entryPrice
      : pos.entryPrice - pos.currentPrice;
    return (diff / pos.entryPrice) * 100;
  }

  private async closePosition(pos: Position, reason: string): Promise<void> {
    log.info("Auto-closing position", {
      tokenId: pos.tokenId,
      reason,
      entryPrice: pos.entryPrice,
      currentPrice: pos.currentPrice,
    });

    // For now, close at current price (in live trading, this would submit a sell order)
    const exitPrice = pos.currentPrice;
    const pnl = this.positions.closePosition(pos.tokenId, exitPrice, 0);
    this.pnlTracker.recordTrade(pnl, 0);

    const msg = `Position auto-closed: ${reason}\n` +
      `Market: ${pos.market}\n` +
      `Entry: $${pos.entryPrice.toFixed(4)} -> Exit: $${exitPrice.toFixed(4)}\n` +
      `P&L: $${pnl.toFixed(4)}`;

    await this.telegram.sendAlert("Position Closed", msg).catch(() => {});
  }
}
