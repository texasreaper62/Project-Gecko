// LLM-powered premarket setup classifier.
//
// Calls Anthropic's Messages API directly (no SDK) to score each premarket
// gap candidate on ORB setup quality. Async, runs once at premarket time,
// does not block any other component if it fails.
//
// Why direct REST instead of @anthropic-ai/sdk: keeps the dependency surface
// minimal. The Messages API is a single POST endpoint with stable shape.
//
// Cost envelope: ~$0.003 per Sonnet call. At 20 candidates per morning,
// that's ~$0.06/day. Negligible.
//
// Outputs persisted to data/llm-classifications.jsonl for post-hoc analysis.

import { createLogger } from "../core/logger.js";
import { appendJsonl } from "../utils/persistence.js";
import { nowIso } from "../utils/time.js";
import type { GapCandidate } from "../scanner/premarket.js";

const log = createLogger("llm-classifier");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const CLASSIFY_TIMEOUT_MS = 30_000;
const CLASSIFICATIONS_LOG = "data/llm-classifications.jsonl";

export interface LlmClassifierConfig {
  readonly apiKey: string;
  readonly model: string;             // e.g. "claude-sonnet-4-6"
  readonly enabled: boolean;
}

export interface ClassificationResult {
  readonly symbol: string;
  readonly score: number;             // 0-10
  readonly sizeMultiplier: number;    // 0.5-1.5, used to scale position
  readonly direction: "LONG" | "SHORT" | "EITHER" | "AVOID";
  readonly reasoning: string;
  readonly raw?: string;
}

interface AnthropicResponse {
  readonly id?: string;
  readonly content?: { type: string; text: string }[];
  readonly stop_reason?: string;
  readonly model?: string;
  readonly usage?: { input_tokens: number; output_tokens: number };
  readonly error?: { type: string; message: string };
}

export class LlmClassifier {
  constructor(private readonly config: LlmClassifierConfig) {}

  isEnabled(): boolean {
    return this.config.enabled && !!this.config.apiKey;
  }

  // Classify a batch of gap candidates. Returns the same list with LLM scores
  // attached; on any failure, returns a neutral baseline score so the
  // strategy never starves on a Claude outage.
  async classify(candidates: readonly GapCandidate[]): Promise<readonly ClassificationResult[]> {
    if (!this.isEnabled()) {
      log.info("LLM classifier disabled, returning neutral scores");
      return candidates.map((c) => neutralResult(c));
    }
    if (candidates.length === 0) return [];

    log.info("Classifying gap candidates", { count: candidates.length });

    // Concurrency bounded — we have 20 in a morning batch, cap at 5 parallel.
    const concurrency = Math.min(5, candidates.length);
    const out: ClassificationResult[] = new Array(candidates.length);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const i = cursor++;
        try {
          out[i] = await this.classifyOne(candidates[i]);
        } catch (err) {
          log.warn("Classification failed, using neutral", {
            symbol: candidates[i].instrument.symbol,
            error: err instanceof Error ? err.message : String(err),
          });
          out[i] = neutralResult(candidates[i]);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    for (const result of out) {
      appendJsonl(CLASSIFICATIONS_LOG, { ts: nowIso(), ...result });
    }

    const avg = out.reduce((s, r) => s + r.score, 0) / out.length;
    log.info("Classification complete", { count: out.length, avgScore: avg.toFixed(2) });
    return out;
  }

  private async classifyOne(candidate: GapCandidate): Promise<ClassificationResult> {
    const prompt = buildPrompt(candidate);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": this.config.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Anthropic HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }

    const parsed = (await resp.json()) as AnthropicResponse;
    if (parsed.error) {
      throw new Error(`Anthropic error: ${parsed.error.type} ${parsed.error.message}`);
    }
    const text = parsed.content?.find((c) => c.type === "text")?.text ?? "";
    return parseLlmResponse(candidate, text);
  }
}

function buildPrompt(c: GapCandidate): string {
  return [
    `You are scoring a premarket stock gap setup for an Opening Range Breakout (ORB) trading strategy.`,
    ``,
    `Symbol: ${c.instrument.symbol}`,
    `Previous close: $${c.previousClose.toFixed(2)}`,
    `Premarket price: $${c.premarketPrice.toFixed(2)}`,
    `Gap: ${c.gapPct.toFixed(2)}% (${c.direction})`,
    `Premarket volume: ${c.premarketVolume.toLocaleString()} shares`,
    ``,
    `Score this setup 0-10 on ORB suitability. Consider:`,
    `- Liquidity (avoid thin names that gap on no volume)`,
    `- Catalyst plausibility given known symbol context (sector, market cap, typical volatility)`,
    `- Gap quality: clean breakouts above prior resistance score higher than chop`,
    `- Volume vs. average (high relative volume is good)`,
    `- Direction conviction: long-only ORB on UP gaps is highest quality; SHORT gaps need confirmation`,
    `- Avoid: biotechs with binary FDA risk, names known for halts, leveraged ETFs, OTC tickers`,
    ``,
    `Reply with EXACTLY this JSON shape, no other text:`,
    `{`,
    `  "score": <0-10>,`,
    `  "sizeMultiplier": <0.5-1.5>,`,
    `  "direction": "LONG" | "SHORT" | "EITHER" | "AVOID",`,
    `  "reasoning": "<one sentence>"`,
    `}`,
  ].join("\n");
}

function parseLlmResponse(candidate: GapCandidate, text: string): ClassificationResult {
  // Find the JSON block in the response. Models sometimes wrap with backticks
  // or add preamble. Extract the first balanced { ... } block.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    log.warn("LLM response not JSON-shaped, using neutral", {
      symbol: candidate.instrument.symbol,
      preview: text.slice(0, 120),
    });
    return neutralResult(candidate, text);
  }

  let parsed: Partial<ClassificationResult>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Partial<ClassificationResult>;
  } catch {
    log.warn("LLM JSON parse failed, using neutral", { symbol: candidate.instrument.symbol });
    return neutralResult(candidate, text);
  }

  const score = clamp(num(parsed.score, 5), 0, 10);
  const sizeMultiplier = clamp(num(parsed.sizeMultiplier, 1.0), 0.5, 1.5);
  const direction = normalizeDirection(parsed.direction, candidate.direction);

  return {
    symbol: candidate.instrument.symbol,
    score,
    sizeMultiplier,
    direction,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    raw: text,
  };
}

function neutralResult(c: GapCandidate, raw?: string): ClassificationResult {
  return {
    symbol: c.instrument.symbol,
    score: 5,
    sizeMultiplier: 1.0,
    direction: c.direction === "UP" ? "LONG" : "SHORT",
    reasoning: "Neutral baseline (classifier disabled or unavailable)",
    raw,
  };
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return (min + max) / 2;
  return Math.min(max, Math.max(min, n));
}

function num(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function normalizeDirection(v: unknown, fallback: "UP" | "DOWN"): ClassificationResult["direction"] {
  if (v === "LONG" || v === "SHORT" || v === "EITHER" || v === "AVOID") return v;
  return fallback === "UP" ? "LONG" : "SHORT";
}
