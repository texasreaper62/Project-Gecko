// Order router. Single entry point for strategies to submit a TradeSignal.
//
// Flow:
//   1. Build the Schwab order payload from the signal
//   2. Run preview (optional, gated by config -- catches bad shapes before
//      they hit the order book)
//   3. Submit via SchwabRest.placeOrder, get orderId
//   4. Track the pending order. Fill confirmation arrives via ACCT_ACTIVITY
//      (handled separately and dispatched back here via onFill)
//   5. If LIVE_TRADING=false, log the signed payload and stop here.
//
// Note: we do NOT block on fill confirmation. The caller fires-and-forgets;
// the position tracker is updated when the stream pushes the fill.

import { createLogger } from "../core/logger.js";
import { appendJsonl } from "../utils/persistence.js";
import { nowIso, etParts } from "../utils/time.js";
import type { AppConfig, TradeSignal, OrderRequest } from "../core/types.js";
import type { Broker, BrokerOrderRequest } from "../brokers/broker.js";
import type { RiskManager } from "../risk/risk-manager.js";
import type { AccountSnapshot, Position } from "../core/types.js";
import type { AgentBrain, MarketContext } from "../intelligence/agent-brain.js";
import type { ConvictionSizer } from "../risk/conviction-sizer.js";
import type { RegimeDetector } from "../intelligence/regime-detector.js";
import type { ConfluenceEngine, CheckResult } from "../intelligence/confluence.js";
import type { MultiTimeframeValidator } from "../intelligence/multi-tf.js";
import type { MarketInternals } from "../intelligence/market-internals.js";
import type { NewsReader } from "../intelligence/news-reader.js";
import type { PatternMatcher } from "../intelligence/pattern-matcher.js";
import type { SectorStrength } from "../intelligence/sector-strength.js";

const log = createLogger("order-router");

const SIGNALS_LOG = "data/signals.jsonl";
const ORDERS_LOG = "data/orders.jsonl";

export interface RouterSubmitResult {
  readonly accepted: boolean;
  readonly orderId?: string;
  readonly reason: string;
}

export interface BrainContextProvider {
  readonly brain: AgentBrain;
  getContext(signal: TradeSignal): MarketContext;
  getOpenPositions(): readonly Position[];
}

export interface ConfluenceStack {
  readonly engine: ConfluenceEngine;
  readonly multiTf: MultiTimeframeValidator;
  readonly internals: MarketInternals;
  readonly news: NewsReader;
  readonly sectorStrength?: SectorStrength;
  readonly patterns: PatternMatcher;
}

export class OrderRouter {
  private brainProvider: BrainContextProvider | null = null;
  private confluence: ConfluenceStack | null = null;
  private convictionSizer: ConvictionSizer | null = null;
  private regimeDetector: RegimeDetector | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly broker: Broker,
    private readonly risk: RiskManager,
  ) {}

  setBrain(provider: BrainContextProvider): void {
    this.brainProvider = provider;
  }

  setConfluence(stack: ConfluenceStack): void {
    this.confluence = stack;
  }

  // Wire conviction-based sizing. When set, the brain's conviction score
  // drives a tiered risk-percent that overrides the strategy's default
  // sizing (1% becomes 1-3.5% based on conviction).
  setConvictionSizer(sizer: ConvictionSizer): void {
    this.convictionSizer = sizer;
  }

  // Wire regime-aware sizing. When set, the current market regime adds a
  // size multiplier (0.4-1.3) on top of conviction sizing.
  setRegimeDetector(rd: RegimeDetector): void {
    this.regimeDetector = rd;
  }

  async submit(signal: TradeSignal, account: AccountSnapshot): Promise<RouterSubmitResult> {
    const t0 = Date.now();
    appendJsonl(SIGNALS_LOG, { ts: nowIso(), signal });

    // ---- TIER 1: instant checks (<100 ms). Fail-fast. ----
    let tier1Checks: CheckResult[] = [];
    let direction: "LONG" | "SHORT" = "LONG";
    let symbol = "";
    if (this.confluence) {
      direction = signalDirection(signal);
      symbol = signal.order.instrument.assetClass === "equity"
        ? signal.order.instrument.symbol
        : signal.order.instrument.underlying;
      const etP = etParts();
      tier1Checks = [
        { name: "strategy-trigger", vote: 1, confidence: 0.7, weight: 1.0, detail: signal.strategy },
        this.confluence.multiTf.evaluate(symbol, direction),
        this.confluence.internals.evaluate(direction),
        this.confluence.patterns.evaluate({
          strategy: signal.strategy,
          direction,
          hourOfDay: etP.hour,
          dayOfWeek: etP.dayOfWeek,
          gapPct: typeof signal.metadata.gapPct === "number" ? signal.metadata.gapPct as number : undefined,
          orWidthPct: typeof signal.metadata.orWidthPct === "number" ? signal.metadata.orWidthPct as number : undefined,
          underlyingMovePct: typeof signal.metadata.movePct === "number" ? signal.metadata.movePct as number : undefined,
        }),
      ];

      // Add sector-strength as an additional tier-1 vote when available.
      if (this.confluence.sectorStrength && signal.order.instrument.assetClass === "equity") {
        tier1Checks.push(this.confluence.sectorStrength.evaluate(signal.order.instrument.symbol, direction));
      }

      // Fail-fast on tier 1.
      // - REJECT if any non-strategy check votes against the trade with confidence.
      // - Otherwise require at least 1 supporting check OR a high-confidence
      //   strategy trigger when no other check has enough data to vote (cold
      //   start). This lets the bot trade from a fresh install where the
      //   pattern matcher has no analogs and multi-tf has no bar history.
      const nonStrat = tier1Checks.filter((c) => c.name !== "strategy-trigger");
      const positives = nonStrat.filter((c) => c.vote > 0.15 && c.confidence >= 0.4).length;
      const negatives = nonStrat.filter((c) => c.vote < -0.15 && c.confidence >= 0.4).length;
      const nonStratWithData = nonStrat.filter((c) => c.confidence >= 0.3).length;
      const canColdStart = nonStratWithData === 0;       // no other check has data
      const passTier1 = negatives === 0 && (positives >= 1 || canColdStart);
      if (!passTier1) {
        log.info("Tier 1 fast-fail", { signalId: signal.id, positives, negatives, withData: nonStratWithData, latencyMs: Date.now() - t0 });
        return { accepted: false, reason: `tier-1 confluence: ${positives} supporting, ${negatives} opposing, ${nonStratWithData} with data` };
      }

      // FAST LANE: if tier 1 is overwhelming, skip Claude entirely and fire.
      // Saves the ~1.5-2.5 sec brain call on the highest-conviction setups.
      // Criteria: pattern matcher analog win rate >= 75% AND multi-TF + internals
      // both strongly supporting (vote >= 0.5 each) AND no opposing votes.
      const patternCheck = tier1Checks.find((c) => c.name === "pattern-matcher");
      const tfCheck = tier1Checks.find((c) => c.name === "multi-tf");
      const intCheck = tier1Checks.find((c) => c.name === "market-internals");
      const patternWinRateHigh = patternCheck && patternCheck.vote >= 0.5 && patternCheck.confidence >= 0.5;
      const tfStrong = tfCheck && tfCheck.vote >= 0.5 && tfCheck.confidence >= 0.6;
      const intStrong = intCheck && intCheck.vote >= 0.5 && intCheck.confidence >= 0.6;
      if (patternWinRateHigh && tfStrong && intStrong && negatives === 0) {
        log.info("FAST LANE: skipping Claude (ultra-high conviction)", {
          signalId: signal.id,
          tier1LatencyMs: Date.now() - t0,
        });
        (signal.metadata as Record<string, unknown>).fastLane = true;
        const riskResult = this.risk.check(signal, account);
        if (!riskResult.allowed) {
          return { accepted: false, reason: riskResult.reason };
        }
        log.info("All gates passed (fast lane)", { signalId: signal.id, latencyMs: Date.now() - t0 });
        return this.dispatch(signal, "live");
      }
    }

    // ---- TIER 2: slow Claude calls IN PARALLEL ----
    const slowPromises: Promise<unknown>[] = [];
    let newsResult: CheckResult | null = null;
    let brainResult: { approved: TradeSignal | null; decision: { go: boolean; conviction: number; sizeMultiplier: number; reasoning: string; revisedStop?: number; revisedTake?: number } } | null = null;

    if (this.confluence) {
      slowPromises.push(
        this.confluence.news.evaluate(symbol, direction)
          .then((r) => { newsResult = r; })
          .catch((err) => {
            newsResult = { name: "news", vote: 0, confidence: 0, weight: 0.8, detail: `err:${errStr(err)}` };
          }),
      );
    }
    if (this.brainProvider && this.brainProvider.brain.isEnabled()) {
      const provider = this.brainProvider;
      slowPromises.push(
        provider.brain.decide(signal, account, provider.getOpenPositions(), provider.getContext(signal))
          .then((r) => { brainResult = r; })
          .catch(() => {
            brainResult = { approved: null, decision: { go: false, conviction: 0, sizeMultiplier: 0, reasoning: "brain error" } };
          }),
      );
    }
    if (slowPromises.length > 0) {
      await Promise.all(slowPromises);
    }

    // Run final confluence with tier 2 included.
    if (this.confluence) {
      const allChecks = [...tier1Checks];
      if (newsResult) allChecks.push(newsResult);
      const conf = this.confluence.engine.evaluate(signal.id, direction, allChecks);
      if (!conf.passed) {
        log.info("Confluence failed (tier 2)", { signalId: signal.id, latencyMs: Date.now() - t0 });
        return { accepted: false, reason: `confluence failed: ${conf.reasoning}` };
      }
      (signal.metadata as Record<string, unknown>).confluenceScore = conf.score;
    }

    let approvedSignal = signal;
    if (brainResult) {
      const br: { approved: TradeSignal | null; decision: { conviction: number; reasoning: string; sizeMultiplier?: number } } = brainResult;
      if (!br.approved) {
        log.info("Brain rejected", { signalId: signal.id, conviction: br.decision.conviction, latencyMs: Date.now() - t0 });
        return { accepted: false, reason: `brain rejected (conviction ${br.decision.conviction}): ${br.decision.reasoning}` };
      }
      approvedSignal = br.approved;

      // Conviction-based sizing: the higher the brain's conviction, the bigger
      // the position. Stacks with regime-aware sizing if both are wired.
      if (this.convictionSizer && this.regimeDetector) {
        const conv = br.decision.conviction;
        const convictionRiskPct = this.convictionSizer.riskPctFor(conv);
        const regimeSnap = this.regimeDetector.get();
        const regimeMul = regimeSnap.sizeMultiplier;
        const baseRisk = this.config.maxRiskPerTradePct;
        const finalRiskPct = Math.min(5.0, Math.max(0.5, convictionRiskPct * regimeMul));
        const scale = finalRiskPct / baseRisk;
        const newQty = Math.max(1, Math.round(approvedSignal.order.quantity * scale));
        log.info("Conviction/regime sizing", {
          signalId: signal.id,
          conviction: conv,
          convictionRiskPct: convictionRiskPct.toFixed(2),
          regime: regimeSnap.regime,
          regimeMul: regimeMul.toFixed(2),
          finalRiskPct: finalRiskPct.toFixed(2),
          qtyBefore: approvedSignal.order.quantity,
          qtyAfter: newQty,
        });
        approvedSignal = {
          ...approvedSignal,
          order: { ...approvedSignal.order, quantity: newQty },
          riskUsd: approvedSignal.riskUsd * scale,
          rewardUsd: approvedSignal.rewardUsd * scale,
          metadata: {
            ...approvedSignal.metadata,
            convictionRiskPct,
            regime: regimeSnap.regime,
            finalRiskPct,
          },
        };
      } else if (this.convictionSizer) {
        const conv = br.decision.conviction;
        const convictionRiskPct = this.convictionSizer.riskPctFor(conv);
        const baseRisk = this.config.maxRiskPerTradePct;
        const scale = convictionRiskPct / baseRisk;
        const newQty = Math.max(1, Math.round(approvedSignal.order.quantity * scale));
        log.info("Conviction sizing", {
          signalId: signal.id,
          conviction: conv,
          riskPct: convictionRiskPct.toFixed(2),
          qtyBefore: approvedSignal.order.quantity,
          qtyAfter: newQty,
        });
        approvedSignal = {
          ...approvedSignal,
          order: { ...approvedSignal.order, quantity: newQty },
          riskUsd: approvedSignal.riskUsd * scale,
          rewardUsd: approvedSignal.rewardUsd * scale,
          metadata: { ...approvedSignal.metadata, convictionRiskPct },
        };
      }
    }

    const riskResult = this.risk.check(approvedSignal, account);
    if (!riskResult.allowed) {
      return { accepted: false, reason: riskResult.reason };
    }

    log.info("All gates passed", { signalId: signal.id, latencyMs: Date.now() - t0 });
    return this.dispatch(approvedSignal, "live");
  }

  // Submit a close order. Skips position-dedup and position-count caps
  // (we WANT to close the existing position), but still honors kill switch.
  async submitClose(signal: TradeSignal): Promise<RouterSubmitResult> {
    appendJsonl(SIGNALS_LOG, { ts: nowIso(), signal, close: true });

    if (this.risk.isKillSwitchActive()) {
      log.warn("Close blocked: kill switch active", { signalId: signal.id });
      return { accepted: false, reason: "Kill switch active" };
    }

    return this.dispatch(signal, "close");
  }

  private async dispatch(signal: TradeSignal, mode: "live" | "close"): Promise<RouterSubmitResult> {
    const brokerReq: BrokerOrderRequest = toBrokerOrder(signal.order);

    if (!this.config.liveTrading) {
      log.info("Dry-run: order built but not submitted", {
        signalId: signal.id,
        strategy: signal.strategy,
        mode,
        broker: this.broker.name,
        brokerReq,
      });
      appendJsonl(ORDERS_LOG, { ts: nowIso(), mode: "dry-run", flow: mode, signal, brokerReq });
      return { accepted: true, reason: "dry-run (LIVE_TRADING=false)" };
    }

    try {
      const result = await this.broker.placeOrder(brokerReq);
      appendJsonl(ORDERS_LOG, { ts: nowIso(), mode: "live", flow: mode, broker: this.broker.name, signalId: signal.id, orderId: result.orderId, signal });
      log.info("Order submitted", { signalId: signal.id, strategy: signal.strategy, flow: mode, broker: this.broker.name, orderId: result.orderId });
      return { accepted: true, orderId: result.orderId, reason: "submitted" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Order submission failed", { signalId: signal.id, flow: mode, error: msg });
      return { accepted: false, reason: `submit error: ${msg}` };
    }
  }

  async cancel(orderId: string): Promise<boolean> {
    if (!this.config.liveTrading) {
      log.info("Dry-run cancel (no-op)", { orderId });
      return true;
    }
    try {
      await this.broker.cancelOrder(orderId);
      return true;
    } catch (err) {
      log.error("Cancel failed", {
        orderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function signalDirection(signal: TradeSignal): "LONG" | "SHORT" {
  const side = signal.order.side;
  if (side === "BUY" || side === "BUY_TO_OPEN") return "LONG";
  if (side === "SELL_TO_OPEN") return "SHORT";
  // SELL on equity in our system is used for short-entry too; check metadata.
  if (side === "SELL" && signal.metadata?.breakoutDirection === "SHORT") return "SHORT";
  return "LONG";
}

// Map an OrderRequest (strategy-facing) to a BrokerOrderRequest (broker-facing).
function toBrokerOrder(r: OrderRequest): BrokerOrderRequest {
  return {
    instrument: r.instrument,
    side: r.side,
    quantity: r.quantity,
    orderType: r.orderType,
    limitPrice: r.limitPrice,
    stopPrice: r.stopPrice,
    tif: r.timeInForce === "GTC" || r.timeInForce === "IOC" ? r.timeInForce : "DAY",
  };
}
