import { createLogger } from "../core/logger.js";
import { readJsonl, appendJsonl } from "../utils/persistence.js";

const log = createLogger("empirical-model");

const SHADOW_FILE = "data/shadow-outcomes.jsonl";
const MODEL_FILE = "data/empirical-model.jsonl";

// Minimum samples in a bucket before we trust the empirical rate
const MIN_SAMPLES = 5;

// Distance buckets: 0-1%, 1-2%, ..., 9-10%, 10%+
const DISTANCE_BUCKETS = 11;
const DISTANCE_BUCKET_SIZE = 1; // percent

// Time buckets: 0-5min, 5-15min, 15-60min, 60min+
const TIME_BUCKET_EDGES = [5, 15, 60]; // minutes; anything above 60 is bucket 3

// Shadow outcome shape (must match shadow-tracker.ts ShadowOutcome + new fields)
interface ShadowOutcomeRecord {
  readonly ts: string;
  readonly opportunityId: string;
  readonly strategy: string;
  readonly predictedProbability: number;
  readonly marketProbability: number;
  readonly predictedEdge: number;
  readonly priceAtSignal: number;
  readonly priceAtResolution: number;
  readonly wouldHaveWon: boolean;
  readonly theoreticalPnl: number;
  readonly holdTimeMs: number;
  // New fields added for empirical bucketing (may be absent on old records)
  readonly spotPriceAtSignal?: number;
  readonly strikePrice?: number;
  readonly timeToExpiryMs?: number;
}

interface BucketData {
  readonly distanceBucket: number; // 0..10
  readonly timeBucket: number;     // 0..3
  samples: number;
  wins: number;
}

interface EmpiricalModelState {
  readonly ts: string;
  readonly buckets: BucketData[];
  readonly totalSamples: number;
}

export class EmpiricalModel {
  // 2D lookup: buckets[distanceBucket][timeBucket]
  private readonly buckets: BucketData[][] = [];
  private totalSamples = 0;

  constructor() {
    // Initialize empty bucket grid
    for (let d = 0; d < DISTANCE_BUCKETS; d++) {
      this.buckets[d] = [];
      for (let t = 0; t < TIME_BUCKET_EDGES.length + 1; t++) {
        this.buckets[d][t] = { distanceBucket: d, timeBucket: t, samples: 0, wins: 0 };
      }
    }

    this.loadFromShadowOutcomes();
    this.loadPersistedState();
  }

  /**
   * Returns the empirical win rate for a given distance-from-strike and time-to-expiry,
   * or null if insufficient data (fewer than MIN_SAMPLES in that bucket).
   */
  getEmpiricalProbability(distancePercent: number, timeToExpiryMin: number): number | null {
    const dBucket = this.getDistanceBucket(distancePercent);
    const tBucket = this.getTimeBucket(timeToExpiryMin);

    const bucket = this.buckets[dBucket][tBucket];
    if (bucket.samples < MIN_SAMPLES) {
      return null;
    }

    return bucket.wins / bucket.samples;
  }

  /**
   * Ingest a new shadow outcome for the empirical model.
   * Call this when shadow-tracker resolves an outcome that has the required fields.
   */
  recordOutcome(
    distancePercent: number,
    timeToExpiryMin: number,
    won: boolean,
  ): void {
    const dBucket = this.getDistanceBucket(distancePercent);
    const tBucket = this.getTimeBucket(timeToExpiryMin);

    const bucket = this.buckets[dBucket][tBucket];
    bucket.samples++;
    if (won) bucket.wins++;
    this.totalSamples++;

    // Persist periodically (every 10 new samples)
    if (this.totalSamples % 10 === 0) {
      this.persist();
    }
  }

  /** Get a summary string for monitoring/logging. */
  getSummary(): string {
    const populated = this.buckets.flat().filter((b) => b.samples >= MIN_SAMPLES);
    const lines = populated.map((b) => {
      const dLabel = b.distanceBucket < DISTANCE_BUCKETS - 1
        ? `${b.distanceBucket * DISTANCE_BUCKET_SIZE}-${(b.distanceBucket + 1) * DISTANCE_BUCKET_SIZE}%`
        : `${(DISTANCE_BUCKETS - 1) * DISTANCE_BUCKET_SIZE}%+`;
      const tLabel = this.timeBucketLabel(b.timeBucket);
      const winRate = ((b.wins / b.samples) * 100).toFixed(1);
      return `  dist=${dLabel} time=${tLabel}: ${winRate}% (${b.samples} samples)`;
    });

    return [
      `Empirical Model: ${this.totalSamples} total samples, ${populated.length} populated buckets`,
      ...lines,
    ].join("\n");
  }

  /** Force-persist current state to disk. */
  persist(): void {
    try {
      const flatBuckets: BucketData[] = [];
      for (let d = 0; d < DISTANCE_BUCKETS; d++) {
        for (let t = 0; t < TIME_BUCKET_EDGES.length + 1; t++) {
          const b = this.buckets[d][t];
          if (b.samples > 0) {
            flatBuckets.push(b);
          }
        }
      }

      const state: EmpiricalModelState = {
        ts: new Date().toISOString(),
        buckets: flatBuckets,
        totalSamples: this.totalSamples,
      };

      appendJsonl(MODEL_FILE, state);

      log.debug("Empirical model persisted", {
        totalSamples: this.totalSamples,
        populatedBuckets: flatBuckets.length,
      });
    } catch (err) {
      log.error("Failed to persist empirical model", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private getDistanceBucket(distancePercent: number): number {
    const abs = Math.abs(distancePercent);
    const bucket = Math.floor(abs / DISTANCE_BUCKET_SIZE);
    return Math.min(bucket, DISTANCE_BUCKETS - 1);
  }

  private getTimeBucket(timeToExpiryMin: number): number {
    for (let i = 0; i < TIME_BUCKET_EDGES.length; i++) {
      if (timeToExpiryMin < TIME_BUCKET_EDGES[i]) return i;
    }
    return TIME_BUCKET_EDGES.length; // 60min+ bucket
  }

  private timeBucketLabel(bucket: number): string {
    if (bucket === 0) return "0-5m";
    if (bucket === 1) return "5-15m";
    if (bucket === 2) return "15-60m";
    return "60m+";
  }

  /**
   * Load historical shadow outcomes and bucket any that have the required fields.
   */
  private loadFromShadowOutcomes(): void {
    try {
      const outcomes = readJsonl<ShadowOutcomeRecord>(SHADOW_FILE);
      let ingested = 0;

      for (const o of outcomes) {
        // Only process outcomes that have the enriched fields
        if (
          o.spotPriceAtSignal != null &&
          o.strikePrice != null &&
          o.timeToExpiryMs != null &&
          o.spotPriceAtSignal > 0
        ) {
          const distancePercent = Math.abs(o.spotPriceAtSignal - o.strikePrice) / o.spotPriceAtSignal * 100;
          const timeToExpiryMin = o.timeToExpiryMs / 60_000;

          const dBucket = this.getDistanceBucket(distancePercent);
          const tBucket = this.getTimeBucket(timeToExpiryMin);

          this.buckets[dBucket][tBucket].samples++;
          if (o.wouldHaveWon) this.buckets[dBucket][tBucket].wins++;
          this.totalSamples++;
          ingested++;
        }
      }

      if (ingested > 0) {
        log.info("Loaded shadow outcomes into empirical model", {
          total: outcomes.length,
          ingested,
          skipped: outcomes.length - ingested,
        });
      }
    } catch {
      // No shadow history yet, that is fine
    }
  }

  /**
   * Load the most recent persisted model state to supplement shadow data.
   * If shadow outcomes were already loaded, the persisted state is only used
   * if it contains MORE samples (i.e., shadow file was truncated/rotated).
   */
  private loadPersistedState(): void {
    try {
      const records = readJsonl<EmpiricalModelState>(MODEL_FILE);
      if (records.length === 0) return;

      const latest = records[records.length - 1];

      // Only use persisted state if shadow loading found fewer samples
      // (this handles the case where shadow file was cleaned up but model state remains)
      if (latest.totalSamples > this.totalSamples) {
        // Reset and use persisted state
        for (let d = 0; d < DISTANCE_BUCKETS; d++) {
          for (let t = 0; t < TIME_BUCKET_EDGES.length + 1; t++) {
            this.buckets[d][t] = { distanceBucket: d, timeBucket: t, samples: 0, wins: 0 };
          }
        }

        for (const b of latest.buckets) {
          if (b.distanceBucket < DISTANCE_BUCKETS && b.timeBucket < TIME_BUCKET_EDGES.length + 1) {
            this.buckets[b.distanceBucket][b.timeBucket] = { ...b };
          }
        }
        this.totalSamples = latest.totalSamples;

        log.info("Used persisted empirical model state (more data than shadow file)", {
          totalSamples: this.totalSamples,
        });
      }
    } catch {
      // No persisted state, that is fine
    }
  }
}
