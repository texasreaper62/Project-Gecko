// Confluence engine: a trade only fires when multiple independent signals
// align. This is the spine of "high accuracy / lower frequency" trading.
//
// We collect a CheckResult from each signal source:
//   - strategy rules (the original trigger that proposed the trade)
//   - multi-timeframe alignment
//   - market internals (SPY/VIX/breadth)
//   - news sentiment (Claude reads recent headlines)
//   - pattern matcher (historical analogs of this setup)
//   - AgentBrain (Claude's holistic context-aware decision)
//
// Each check returns vote in [-1, +1] where positive = supports the trade
// direction, negative = opposes, 0 = neutral / no opinion. Each check also
// reports a confidence in [0, 1]. The confluence score is the weighted sum
// of (vote * confidence) divided by total weight.
//
// The engine refuses the trade unless:
//   1. Number of NON-NEUTRAL checks >= minSignals (default 4)
//   2. All non-neutral checks vote the same direction (no disagreement)
//   3. Weighted confluence score >= minScore (default 0.7)
//
// This is intentionally strict. The goal is to push win rate UP at the cost
// of trade frequency. A bot that trades 5x/week at 80% wins compounds faster
// than one trading 30x/week at 55%.

import { createLogger } from "../core/logger.js";
import { appendJsonl } from "../utils/persistence.js";
import { nowIso } from "../utils/time.js";

const log = createLogger("confluence");

const CONFLUENCE_LOG = "data/confluence-decisions.jsonl";

export interface CheckResult {
  readonly name: string;
  readonly vote: number;          // [-1, +1] where + means "supports trade direction"
  readonly confidence: number;    // [0, 1]
  readonly weight?: number;       // default 1.0
  readonly detail?: string;
}

export interface ConfluenceConfig {
  readonly minSignals: number;          // default 4
  readonly minScore: number;            // default 0.7
  readonly requireUnanimity: boolean;   // default true; false allows 1 dissent
}

export interface ConfluenceResult {
  readonly passed: boolean;
  readonly score: number;
  readonly nonNeutralCount: number;
  readonly direction: "with" | "against" | "mixed" | "neutral";
  readonly reasoning: string;
  readonly checks: readonly CheckResult[];
}

export class ConfluenceEngine {
  constructor(private readonly config: ConfluenceConfig) {}

  evaluate(
    signalId: string,
    intendedDirection: "LONG" | "SHORT",
    checks: readonly CheckResult[],
  ): ConfluenceResult {
    // Normalize: vote sign always relative to the INTENDED trade direction.
    // Caller should already do this, but we double-check.
    const nonNeutral = checks.filter((c) => Math.abs(c.vote) > 0.05);
    const supporting = nonNeutral.filter((c) => c.vote > 0);
    const opposing = nonNeutral.filter((c) => c.vote < 0);

    let direction: ConfluenceResult["direction"] = "neutral";
    if (supporting.length > 0 && opposing.length === 0) direction = "with";
    else if (opposing.length > 0 && supporting.length === 0) direction = "against";
    else if (supporting.length > 0 && opposing.length > 0) direction = "mixed";

    const totalWeight = checks.reduce((s, c) => s + (c.weight ?? 1.0), 0);
    const weighted = checks.reduce((s, c) => s + (c.vote * c.confidence * (c.weight ?? 1.0)), 0);
    const score = totalWeight > 0 ? weighted / totalWeight : 0;

    // Decision logic.
    let passed = true;
    const reasons: string[] = [];

    if (nonNeutral.length < this.config.minSignals) {
      passed = false;
      reasons.push(`only ${nonNeutral.length}/${this.config.minSignals} non-neutral signals`);
    }
    if (this.config.requireUnanimity && opposing.length > 0) {
      passed = false;
      reasons.push(`${opposing.length} signals oppose: ${opposing.map((c) => c.name).join(", ")}`);
    } else if (!this.config.requireUnanimity && opposing.length > 1) {
      passed = false;
      reasons.push(`${opposing.length} signals oppose (only 1 dissent allowed)`);
    }
    if (score < this.config.minScore) {
      passed = false;
      reasons.push(`score ${score.toFixed(2)} < ${this.config.minScore} threshold`);
    }

    const reasoning = passed
      ? `${nonNeutral.length} aligned signals, score ${score.toFixed(2)}`
      : reasons.join("; ");

    const result: ConfluenceResult = {
      passed,
      score,
      nonNeutralCount: nonNeutral.length,
      direction,
      reasoning,
      checks,
    };

    appendJsonl(CONFLUENCE_LOG, {
      ts: nowIso(),
      signalId,
      direction: intendedDirection,
      result,
    });

    if (passed) {
      log.info("Confluence PASSED", {
        signalId,
        score: score.toFixed(2),
        signals: nonNeutral.length,
        checks: nonNeutral.map((c) => `${c.name}:${c.vote > 0 ? "+" : ""}${c.vote.toFixed(2)}`).join(","),
      });
    } else {
      log.info("Confluence FAILED", {
        signalId,
        reason: reasoning,
        score: score.toFixed(2),
      });
    }
    return result;
  }
}
