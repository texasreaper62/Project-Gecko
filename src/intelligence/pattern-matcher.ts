// Pattern matcher: finds historical setups similar to the current proposed
// trade and reports the realized win rate of those historical setups.
//
// This gives the confluence engine an evidence-based vote: "the last N
// similar setups paid off X% of the time."
//
// Feature vector per closed trade:
//   - strategy (categorical)
//   - direction (LONG|SHORT)
//   - hourOfDay (0-23)
//   - dayOfWeek (0-6)
//   - gapPct (continuous; ORB-specific)
//   - orWidthPct (continuous; ORB)
//   - underlyingMovePct (continuous; Engine B)
//   - rTarget (continuous)
//   - vixLevel (continuous; from market internals at trade time, if stored)
//
// Similarity = weighted Euclidean distance on normalized features, plus
// hard match on strategy + direction.
//
// Output:
//   - vote: scaled to win rate (winRate * 2 - 1, so 50% = 0, 100% = +1)
//     when the analog set is consistent; +0.5 at 75%, etc.
//   - confidence: rises with the number of matching historical analogs
//   - detail: "N analogs, R% win rate"

import { createLogger } from "../core/logger.js";
import { readJsonl } from "../utils/persistence.js";
import type { CheckResult } from "./confluence.js";

const log = createLogger("pattern-matcher");

const OUTCOMES_FILE = "data/outcomes.jsonl";
const MIN_ANALOGS = 5;
const MAX_ANALOGS = 20;

interface OutcomeRecord {
  readonly ts: string;
  readonly strategy: string;
  readonly side: "LONG" | "SHORT";
  readonly pnl: number;
  readonly metadata?: Record<string, unknown>;
}

interface SetupVector {
  readonly strategy: string;
  readonly direction: "LONG" | "SHORT";
  readonly hourOfDay: number;
  readonly dayOfWeek: number;
  readonly gapPct?: number;
  readonly orWidthPct?: number;
  readonly underlyingMovePct?: number;
  readonly rTarget?: number;
}

export class PatternMatcher {
  private outcomes: OutcomeRecord[] = [];

  constructor() {
    this.reload();
  }

  reload(): void {
    try {
      this.outcomes = readJsonl<OutcomeRecord>(OUTCOMES_FILE);
      log.info("Loaded outcomes", { count: this.outcomes.length });
    } catch {
      this.outcomes = [];
    }
  }

  evaluate(setup: SetupVector): CheckResult {
    // Filter to same strategy + same direction.
    const candidates = this.outcomes.filter((o) =>
      o.strategy === setup.strategy && o.side === setup.direction,
    );

    if (candidates.length < MIN_ANALOGS) {
      return {
        name: "pattern-matcher",
        vote: 0,
        confidence: 0.1,
        weight: 1.0,
        detail: `only ${candidates.length} historical analogs (need ${MIN_ANALOGS}+)`,
      };
    }

    // Score each candidate's similarity to the current setup.
    const scored = candidates.map((o) => {
      const meta = o.metadata ?? {};
      let dist = 0;
      let dims = 0;

      const tsHour = new Date(o.ts).getUTCHours();
      const tsDow = new Date(o.ts).getUTCDay();
      dist += Math.abs(tsHour - setup.hourOfDay) / 24; dims++;
      dist += Math.abs(tsDow - setup.dayOfWeek) / 7; dims++;

      if (setup.gapPct !== undefined && typeof meta.gapPct === "number") {
        dist += Math.abs((meta.gapPct as number) - setup.gapPct) / 10; dims++;
      }
      if (setup.orWidthPct !== undefined && typeof meta.orWidthPct === "number") {
        dist += Math.abs((meta.orWidthPct as number) - setup.orWidthPct) / 5; dims++;
      }
      if (setup.underlyingMovePct !== undefined && typeof meta.movePct === "number") {
        dist += Math.abs((meta.movePct as number) - setup.underlyingMovePct) / 5; dims++;
      }

      return { outcome: o, dist: dims > 0 ? dist / dims : 1.0 };
    });

    scored.sort((a, b) => a.dist - b.dist);
    const topN = scored.slice(0, Math.min(MAX_ANALOGS, scored.length));
    const wins = topN.filter((s) => s.outcome.pnl > 0).length;
    const winRate = wins / topN.length;

    // Vote: scale win rate to [-1, +1]. 50% = neutral, 100% = +1, 0% = -1.
    const vote = winRate * 2 - 1;
    // Confidence based on sample size and similarity distance.
    const avgDist = topN.reduce((s, x) => s + x.dist, 0) / topN.length;
    const sampleConfidence = Math.min(1, topN.length / 20);
    const similarityConfidence = Math.max(0.2, 1 - avgDist);
    const confidence = sampleConfidence * similarityConfidence;

    return {
      name: "pattern-matcher",
      vote,
      confidence,
      weight: 1.5,
      detail: `${topN.length} analogs, ${(winRate * 100).toFixed(0)}% win rate, avg-dist=${avgDist.toFixed(2)}`,
    };
  }
}
