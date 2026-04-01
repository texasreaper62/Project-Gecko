import { createLogger } from "../core/logger.js";
import type { AppConfig, Position, TradeParams, Opportunity } from "../core/types.js";
import type { PositionTracker } from "./position-tracker.js";
import type { OrderExecutor } from "./order-executor.js";
import type { FeedAggregator } from "../feeds/feed-aggregator.js";
import type { PnlTracker } from "../monitoring/pnl-tracker.js";
import type { TelegramNotifier } from "../monitoring/telegram.js";
import type { SelfTuner } from "../strategies/self-tuner.js";

const log = createLogger("position-closer");

// Check positions every 5 seconds
const CHECK_INTERVAL = 5_000;
// Take profit at 15% gain
const TAKE_PROFIT_PERCENT = 15;
// Stop loss at -10% loss
const STOP_LOSS_PERCENT = -10;
// Max hold time for short-term arb positions
const MAX_HOLD_MS = 30 * 60 * 1000;

export class PositionCloser {
  private readonly config: AppConfig;
  private readonly positions: PositionTracker;
  private readonly executor: OrderExecutor;
  private readonly aggregator: FeedAggregator;
  private readonly pnlTracker: PnlTracker;
  private readonly telegram: TelegramNotifier;
  private readonly selfTuner: SelfTuner | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly closingTokens: Set<string> = new Set();

  constructor(
    config: AppConfig,
    positions: PositionTracker,
    executor: OrderExecutor,
    aggregator: FeedAggregator,
    pnlTracker: PnlTracker,
    telegram: TelegramNotifier,
    selfTuner?: SelfTuner,
  ) {
    this.config = config;
    this.positions = positions;
    this.executor = executor;
    this.aggregator = aggregator;
    this.pnlTracker = pnlTracker;
    this.telegram = telegram;
    this.selfTuner = selfTuner ?? null;
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
      // Skip if already being closed
      if (this.closingTokens.has(pos.tokenId)) continue;

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
    const pnlPct = this.pnlPercent(pos);

    if (pnlPct >= TAKE_PROFIT_PERCENT) {
      return `Take profit: ${pnlPct.toFixed(1)}% gain`;
    }

    if (pnlPct <= STOP_LOSS_PERCENT) {
      return `Stop loss: ${pnlPct.toFixed(1)}% loss`;
    }

    const holdTimeMs = Date.now() - pos.openTimestamp;
    if (holdTimeMs > MAX_HOLD_MS) {
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
    this.closingTokens.add(pos.tokenId);

    log.info("Auto-closing position", {
      tokenId: pos.tokenId,
      reason,
      entryPrice: pos.entryPrice,
      currentPrice: pos.currentPrice,
    });

    try {
      // Submit actual sell order if live trading is enabled
      let exitPrice = pos.currentPrice;
      let fees = 0;

      if (this.config.liveTrading) {
        const sellParams: TradeParams = {
          tokenId: pos.tokenId,
          side: "SELL",
          price: pos.currentPrice,
          size: pos.size,
          orderType: "FOK",
          conditionId: pos.conditionId,
          negRisk: false,
        };

        const result = await this.executor.submitSellOrder(sellParams);
        if (result && (result.status === "filled" || result.status === "partial")) {
          exitPrice = result.fillPrice;
          fees = result.fees;
        } else {
          // Sell order failed or was rejected; log but still close locally
          // The tokens remain in the wallet but we remove tracking
          log.warn("Sell order did not fill, closing position locally", {
            tokenId: pos.tokenId,
            result: result?.status ?? "null",
          });
        }
      }

      const pnl = this.positions.closePosition(pos.tokenId, exitPrice, fees);
      this.pnlTracker.recordTrade(pnl, fees);
      this.executor.recordTradeResult(pnl);

      // Record outcome for self-tuning
      if (this.selfTuner && pos.opportunityMetadata) {
        const fakeOpp: Opportunity = {
          id: (pos.opportunityMetadata.opportunityId as string) ?? "unknown",
          strategy: pos.strategy,
          timestamp: pos.openTimestamp,
          description: pos.market,
          expectedSpread: (pos.opportunityMetadata.expectedSpread as number) ?? 0,
          confidence: 0,
          params: {
            tokenId: pos.tokenId,
            side: pos.side,
            price: pos.entryPrice,
            size: pos.size,
            orderType: "FOK",
            conditionId: pos.conditionId,
            negRisk: false,
          },
          metadata: pos.opportunityMetadata,
        };
        this.selfTuner.recordOutcome(
          fakeOpp,
          pos.entryPrice,
          exitPrice,
          pnl,
          Date.now() - pos.openTimestamp,
        );
      }

      const msg = `Position auto-closed: ${reason}\n` +
        `Market: ${pos.market}\n` +
        `Entry: $${pos.entryPrice.toFixed(4)} -> Exit: $${exitPrice.toFixed(4)}\n` +
        `P&L: $${pnl.toFixed(4)}`;

      await this.telegram.sendAlert("Position Closed", msg).catch(() => {});
    } finally {
      this.closingTokens.delete(pos.tokenId);
    }
  }
}
