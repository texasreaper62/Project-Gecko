// Anthropic API spend tracker.
//
// Every Claude API call (brain, news reader, premarket classifier) records:
//   - timestamp
//   - model id
//   - caller component
//   - input_tokens (incl. cached)
//   - output_tokens
//   - cache_creation_input_tokens (5m cache writes)
//   - cache_read_input_tokens (cache hits)
//   - computed USD cost
//
// Written to data/anthropic-spend.jsonl. The daily report sums this per
// day/month and subtracts from gross P&L to show NET profitability.
//
// Pricing table is hardcoded here, sourced from Anthropic's pricing page
// as of May 19, 2026. Update when new models / price changes ship.

import { createLogger } from "../core/logger.js";
import { appendJsonl } from "../utils/persistence.js";
import { nowIso } from "../utils/time.js";

const log = createLogger("cost-tracker");

const SPEND_LOG = "data/anthropic-spend.jsonl";

// Pricing in USD per 1M tokens. Sourced from Anthropic docs May 19, 2026.
// Cache write multipliers: 5m = 1.25x base input, 1h = 2x base input.
// Cache read: 0.1x base input (10% of base price).
interface ModelPricing {
  readonly inputPerMTok: number;       // base input
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;   // cache hit / refresh
  readonly cacheWrite5mPerMTok: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Opus tier
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWrite5mPerMTok: 6.25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWrite5mPerMTok: 6.25 },
  "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWrite5mPerMTok: 6.25 },
  "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWrite5mPerMTok: 18.75 },
  // Sonnet tier
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWrite5mPerMTok: 3.75 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWrite5mPerMTok: 3.75 },
  // Haiku tier
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWrite5mPerMTok: 1.25 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWrite5mPerMTok: 1.25 },
};

// Anthropic Messages API usage object shape.
export interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

export interface SpendRecord {
  readonly ts: string;
  readonly component: string;            // "agent-brain" | "news-reader" | "llm-classifier"
  readonly model: string;
  readonly inputTokens: number;          // tokens billed at base input price
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
}

export class AnthropicCostTracker {
  // Aggregates in-memory in case caller wants a running total without re-reading
  // the log. The JSONL log is the source of truth.
  private totalUsd = 0;
  private callCount = 0;

  // Record one API call's usage and persist to the spend log.
  record(component: string, model: string, usage: AnthropicUsage | undefined): SpendRecord | null {
    if (!usage) return null;
    const pricing = PRICING[model];
    if (!pricing) {
      log.warn("Unknown model for cost tracking; using opus-4-7 rates as fallback", { model });
    }
    const p = pricing ?? PRICING["claude-opus-4-7"];

    // Anthropic's API conventions:
    //   input_tokens          = fresh (non-cached) input tokens
    //   cache_creation_input_tokens = tokens written to cache (5m by default)
    //   cache_read_input_tokens     = tokens read from cache (cheap)
    //   output_tokens               = generated tokens
    const freshInput = usage.input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;

    const costUsd =
      (freshInput / 1_000_000) * p.inputPerMTok +
      (cacheWrite / 1_000_000) * p.cacheWrite5mPerMTok +
      (cacheRead / 1_000_000) * p.cacheReadPerMTok +
      (output / 1_000_000) * p.outputPerMTok;

    const record: SpendRecord = {
      ts: nowIso(),
      component,
      model,
      inputTokens: freshInput,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd,
    };

    appendJsonl(SPEND_LOG, record);
    this.totalUsd += costUsd;
    this.callCount++;
    log.debug("Spend recorded", {
      component, model, costUsd: costUsd.toFixed(4),
      sessionTotal: this.totalUsd.toFixed(4),
    });
    return record;
  }

  getSessionTotal(): { totalUsd: number; callCount: number } {
    return { totalUsd: this.totalUsd, callCount: this.callCount };
  }
}

// Singleton instance — every Anthropic-calling component imports and uses this.
export const costTracker = new AnthropicCostTracker();
