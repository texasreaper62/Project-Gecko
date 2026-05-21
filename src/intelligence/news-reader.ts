// News reader: pulls recent headlines for a symbol and uses Claude to score
// directional sentiment. Output is a CheckResult vote for the confluence
// engine.
//
// Headlines source: Yahoo Finance news API (free, no auth). Documented to
// return the most recent 20-50 headlines per ticker, sorted by recency.
//
// Cadence: we cache headlines per (symbol, 5-minute window). News doesn't
// move that fast for typical tickers, and we want to avoid hammering the
// API or the Claude endpoint.

import { createLogger } from "../core/logger.js";
import type { CheckResult } from "./confluence.js";

const log = createLogger("news-reader");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const SENTIMENT_TIMEOUT_MS = 8_000;
const HEADLINES_CACHE_TTL_MS = 5 * 60 * 1000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

interface YahooNewsItem {
  readonly title?: string;
  readonly publisher?: string;
  readonly providerPublishTime?: number;
  readonly link?: string;
}

interface YahooSearchResponse {
  readonly news?: YahooNewsItem[];
}

interface CachedHeadlines {
  readonly fetchedAt: number;
  readonly headlines: readonly { title: string; ts: number }[];
}

export interface NewsReaderConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly enabled: boolean;
}

export class NewsReader {
  private cache: Map<string, CachedHeadlines> = new Map();

  constructor(private readonly config: NewsReaderConfig) {}

  isEnabled(): boolean {
    return this.config.enabled && this.config.apiKey.length > 0;
  }

  async evaluate(symbol: string, direction: "LONG" | "SHORT"): Promise<CheckResult> {
    if (!this.isEnabled()) {
      return { name: "news", vote: 0, confidence: 0, weight: 0.8, detail: "disabled" };
    }

    let headlines: readonly { title: string; ts: number }[];
    try {
      headlines = await this.fetchHeadlines(symbol);
    } catch (err) {
      log.warn("Headlines fetch failed", { symbol, error: err instanceof Error ? err.message : String(err) });
      return { name: "news", vote: 0, confidence: 0, weight: 0.8, detail: "fetch failed" };
    }
    if (headlines.length === 0) {
      return { name: "news", vote: 0, confidence: 0.3, weight: 0.8, detail: "no headlines" };
    }

    const recent = headlines.slice(0, 8);
    let scored;
    try {
      scored = await this.scoreHeadlines(symbol, recent.map((h) => h.title));
    } catch (err) {
      log.warn("Headline scoring failed", { symbol, error: err instanceof Error ? err.message : String(err) });
      return { name: "news", vote: 0, confidence: 0.2, weight: 0.8, detail: "score failed" };
    }

    // scored.sentiment in [-1, +1] where + = bullish, - = bearish.
    // Vote relative to direction.
    const directionalVote = direction === "LONG" ? scored.sentiment : -scored.sentiment;
    return {
      name: "news",
      vote: directionalVote,
      confidence: scored.confidence,
      weight: 0.8,
      detail: scored.summary,
    };
  }

  private async fetchHeadlines(symbol: string): Promise<readonly { title: string; ts: number }[]> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < HEADLINES_CACHE_TTL_MS) {
      return cached.headlines;
    }

    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=10&quotesCount=0`;
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (!resp.ok) throw new Error(`Yahoo news HTTP ${resp.status}`);
    const data = (await resp.json()) as YahooSearchResponse;
    const headlines: { title: string; ts: number }[] = [];
    for (const n of data.news ?? []) {
      if (typeof n.title === "string" && typeof n.providerPublishTime === "number") {
        headlines.push({ title: n.title, ts: n.providerPublishTime * 1000 });
      }
    }
    headlines.sort((a, b) => b.ts - a.ts);
    this.cache.set(symbol, { fetchedAt: Date.now(), headlines });
    return headlines;
  }

  private async scoreHeadlines(symbol: string, headlines: readonly string[]): Promise<{ sentiment: number; confidence: number; summary: string }> {
    const prompt = [
      `Score the directional sentiment of these recent headlines for ${symbol} from a short-term trading perspective.`,
      ``,
      headlines.map((h, i) => `${i + 1}. ${h}`).join("\n"),
      ``,
      `Output EXACTLY this JSON, no other text:`,
      `{`,
      `  "sentiment": <number in [-1, +1] where +1 = strongly bullish, -1 = strongly bearish, 0 = neutral or mixed>,`,
      `  "confidence": <number in [0, 1]>,`,
      `  "summary": "<one short sentence describing the dominant theme>"`,
      `}`,
    ].join("\n");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SENTIMENT_TIMEOUT_MS);
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
          max_tokens: 200,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Anthropic HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const json = (await resp.json()) as { content?: { type: string; text: string }[] };
    const text = json.content?.find((c) => c.type === "text")?.text ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return { sentiment: 0, confidence: 0.2, summary: "unparseable LLM output" };
    }
    const parsed = JSON.parse(text.slice(start, end + 1)) as { sentiment?: number; confidence?: number; summary?: string };
    return {
      sentiment: clamp(num(parsed.sentiment, 0), -1, 1),
      confidence: clamp(num(parsed.confidence, 0.5), 0, 1),
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
    };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, n));
}

function num(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
