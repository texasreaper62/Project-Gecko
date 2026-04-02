import { createLogger } from "../core/logger.js";
import { sleep } from "./time.js";

const log = createLogger("rate-limiter");

// Token bucket rate limiter
export class RateLimiter {
  private readonly name: string;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private tokens: number;
  private lastRefill: number;

  constructor(name: string, maxTokens: number, refillRate: number) {
    if (refillRate <= 0) throw new Error(`RateLimiter ${name}: refillRate must be > 0`);
    if (maxTokens <= 0) throw new Error(`RateLimiter ${name}: maxTokens must be > 0`);
    this.name = name;
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  // Acquire a token, waiting if necessary
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Wait for next token
    const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;
    log.debug(`Rate limited on ${this.name}, waiting ${waitMs.toFixed(0)}ms`);
    await sleep(waitMs);
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  // Try to acquire without waiting; returns false if rate limited
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// Pre-configured limiters for Polymarket API
// General: 5000 req/10s = 500/s
export function createGeneralLimiter(): RateLimiter {
  return new RateLimiter("polymarket-general", 500, 500);
}

// /book and /price: 200 req/10s = 20/s
export function createBookPriceLimiter(): RateLimiter {
  return new RateLimiter("polymarket-book-price", 20, 20);
}

// POST /order: 40/s sustained
export function createOrderLimiter(): RateLimiter {
  return new RateLimiter("polymarket-order", 40, 40);
}

// Gamma /events: 100 req/10s = 10/s
export function createGammaEventsLimiter(): RateLimiter {
  return new RateLimiter("gamma-events", 10, 10);
}

// Gamma /markets: 125 req/10s = 12.5/s
export function createGammaMarketsLimiter(): RateLimiter {
  return new RateLimiter("gamma-markets", 12, 12.5);
}
