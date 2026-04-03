import { createLogger } from "../core/logger.js";
import type { Opportunity, StrategyType } from "../core/types.js";
import type { PolymarketRestClient } from "../feeds/polymarket-rest.js";
import type { SelfTuner } from "./self-tuner.js";
import type { EmpiricalModel } from "./empirical-model.js";
import { appendJsonl, readJsonl } from "../utils/persistence.js";

const log = createLogger("shadow-tracker");

const SHADOW_FILE = "data/shadow-outcomes.jsonl";
// Check pending outcomes every 2 minutes
const CHECK_INTERVAL = 120_000;
// Max age before we give up on checking an outcome (2 hours)
const MAX_PENDING_AGE_MS = 7_200_000;
// Max pending opportunities to track at once
const MAX_PENDING = 200;

interface PendingOpportunity {
  readonly id: string;
  readonly strategy: StrategyType;
  readonly tokenId: string;
  readonly conditionId: string;
  readonly predictedProbability: number;
  readonly marketProbability: number;
  readonly predictedEdge: number;
  readonly side: "BUY" | "SELL";
  readonly priceAtSignal: number;
  readonly spotPriceAtSignal: number;
  readonly timestamp: number;
  readonly expiryEstimate: number;
}

interface ShadowOutcome {
  readonly ts: string;
  readonly opportunityId: string;
  readonly strategy: StrategyType;
  readonly predictedProbability: number;
  readonly marketProbability: number;
  readonly predictedEdge: number;
  readonly priceAtSignal: number;
  readonly priceAtResolution: number;
  readonly wouldHaveWon: boolean;
  readonly theoreticalPnl: number;
  readonly holdTimeMs: number;
}

export class ShadowTracker {
  private readonly polyRest: PolymarketRestClient;
  private readonly selfTuner: SelfTuner;
  private readonly pending: Map<string, PendingOpportunity> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  // Lifetime stats (not persisted, rebuilt from shadow-outcomes.jsonl on restart)
  private totalTracked = 0;
  private totalWouldHaveWon = 0;
  private totalTheoreticalPnl = 0;

  private readonly empiricalModel: EmpiricalModel | null;

  constructor(polyRest: PolymarketRestClient, selfTuner: SelfTuner, empiricalModel?: EmpiricalModel) {
    this.polyRest = polyRest;
    this.selfTuner = selfTuner;
    this.empiricalModel = empiricalModel ?? null;
    this.loadStats();
  }

  // Called for every opportunity the bot detects (whether traded or not)
  trackOpportunity(opp: Opportunity): void {
    if (this.pending.size >= MAX_PENDING) return;

    const predicted = typeof opp.metadata.trueProbability === "number"
      ? opp.metadata.trueProbability : null;
    const market = typeof opp.metadata.marketProbability === "number"
      ? opp.metadata.marketProbability : null;
    const spotPrice = typeof opp.metadata.spotPrice === "number"
      ? opp.metadata.spotPrice : 0;

    if (predicted === null || market === null) return;

    this.pending.set(opp.id, {
      id: opp.id,
      strategy: opp.strategy,
      tokenId: opp.params.tokenId,
      conditionId: opp.params.conditionId,
      predictedProbability: predicted,
      marketProbability: market,
      predictedEdge: opp.expectedSpread,
      side: opp.params.side === "BUY" ? "BUY" : "SELL",
      priceAtSignal: opp.params.price,
      spotPriceAtSignal: spotPrice,
      timestamp: opp.timestamp,
      expiryEstimate: opp.timestamp + (typeof opp.metadata.timeToExpiryMs === "number"
        ? opp.metadata.timeToExpiryMs : 900_000),
    });
  }

  start(): void {
    this.timer = setInterval(() => {
      this.checkPendingOutcomes().catch((err) => {
        log.error("Shadow check error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, CHECK_INTERVAL);
    log.info("Shadow tracker started", {
      pending: this.pending.size,
      historicalOutcomes: this.totalTracked,
      theoreticalWinRate: this.totalTracked > 0
        ? ((this.totalWouldHaveWon / this.totalTracked) * 100).toFixed(1) + "%"
        : "n/a",
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSummary(): string {
    const winRate = this.totalTracked > 0
      ? (this.totalWouldHaveWon / this.totalTracked * 100).toFixed(1)
      : "n/a";
    return [
      `Shadow Tracker (no real money):`,
      `  Opportunities tracked: ${this.totalTracked}`,
      `  Would have won: ${this.totalWouldHaveWon}/${this.totalTracked} (${winRate}%)`,
      `  Theoretical P&L: $${this.totalTheoreticalPnl.toFixed(2)}`,
      `  Pending resolution: ${this.pending.size}`,
    ].join("\n");
  }

  private async checkPendingOutcomes(): Promise<void> {
    const now = Date.now();
    const resolved: string[] = [];

    for (const [id, pending] of this.pending) {
      // Skip if not yet past estimated expiry
      if (now < pending.expiryEstimate) continue;

      // Give up on very old entries
      if (now - pending.timestamp > MAX_PENDING_AGE_MS) {
        resolved.push(id);
        continue;
      }

      // Check the current price of the token (post-resolution, it should be near 0 or 1)
      try {
        const currentPrice = await this.polyRest.getMidpoint(pending.tokenId);

        // A resolved market has YES tokens near 1.0 (won) or near 0.0 (lost)
        // If still mid-range (0.1-0.9), not resolved yet
        if (currentPrice > 0.1 && currentPrice < 0.9) continue;

        const resolvedYes = currentPrice >= 0.9;
        const wouldHaveBoughtYes = pending.side === "BUY";

        // Did our predicted direction match reality?
        const wouldHaveWon = wouldHaveBoughtYes === resolvedYes;

        // Theoretical P&L: (resolution price - entry price) * hypothetical size
        const entryPrice = pending.priceAtSignal;
        const exitPrice = resolvedYes ? 1.0 : 0.0;
        const theoreticalPnl = wouldHaveBoughtYes
          ? (exitPrice - entryPrice) * 50 // Use $50 hypothetical position
          : (entryPrice - exitPrice) * 50;

        const outcome: ShadowOutcome = {
          ts: new Date().toISOString(),
          opportunityId: pending.id,
          strategy: pending.strategy,
          predictedProbability: pending.predictedProbability,
          marketProbability: pending.marketProbability,
          predictedEdge: pending.predictedEdge,
          priceAtSignal: entryPrice,
          priceAtResolution: currentPrice,
          wouldHaveWon: wouldHaveWon,
          theoreticalPnl,
          holdTimeMs: now - pending.timestamp,
        };

        appendJsonl(SHADOW_FILE, outcome);
        this.totalTracked++;
        if (wouldHaveWon) this.totalWouldHaveWon++;
        this.totalTheoreticalPnl += theoreticalPnl;

        // Feed into self-tuner and empirical model
        this.selfTuner.recordShadowOutcome(
          pending.strategy,
          pending.predictedProbability,
          pending.marketProbability,
          pending.predictedEdge,
          wouldHaveWon,
        );

        // Feed empirical model with distance/time/outcome data
        if (this.empiricalModel && pending.spotPriceAtSignal > 0) {
          const distPct = Math.abs(pending.spotPriceAtSignal - pending.priceAtSignal) / pending.spotPriceAtSignal * 100;
          const tteMins = (pending.expiryEstimate - pending.timestamp) / 60_000;
          this.empiricalModel.recordOutcome(distPct, tteMins, wouldHaveWon);
        }

        log.info("Shadow outcome resolved", {
          id: pending.id,
          strategy: pending.strategy,
          wouldHaveWon,
          theoreticalPnl: theoreticalPnl.toFixed(2),
          predicted: (pending.predictedProbability * 100).toFixed(1) + "%",
          actual: resolvedYes ? "YES" : "NO",
        });

        resolved.push(id);
      } catch {
        // API error - skip this one for now, try again next cycle
      }
    }

    for (const id of resolved) {
      this.pending.delete(id);
    }
  }

  private loadStats(): void {
    try {
      const outcomes = readJsonl<ShadowOutcome>(SHADOW_FILE);
      for (const o of outcomes) {
        this.totalTracked++;
        if (o.wouldHaveWon) this.totalWouldHaveWon++;
        this.totalTheoreticalPnl += o.theoreticalPnl;
      }
      if (outcomes.length > 0) {
        log.info("Loaded shadow history", {
          outcomes: outcomes.length,
          winRate: ((this.totalWouldHaveWon / this.totalTracked) * 100).toFixed(1) + "%",
        });
      }
    } catch { /* no history yet */ }
  }
}
