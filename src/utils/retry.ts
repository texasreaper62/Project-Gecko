import { createLogger } from "../core/logger.js";
import { sleep } from "./time.js";

const log = createLogger("retry");

export interface RetryOptions {
  readonly maxAttempts?: number;    // default 3
  readonly initialDelay?: number;   // ms, default 1000
  readonly maxDelay?: number;       // ms, default 10000
  readonly timeout?: number;        // ms per attempt, default 10000
}

const DEFAULTS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  timeout: 10000,
};

export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  label: string,
  opts?: RetryOptions,
): Promise<T> {
  const { maxAttempts, initialDelay, maxDelay, timeout } = { ...DEFAULTS, ...opts };
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const result = await fn(controller.signal);
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxAttempts) {
        const delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
        log.warn(`${label} attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms`, {
          error: lastError.message,
        });
        await sleep(delay);
      } else {
        log.error(`${label} failed after ${maxAttempts} attempts`, {
          error: lastError.message,
        });
      }
    }
  }

  throw lastError!;
}

// Simple HTTP fetch with timeout and retry
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts?: RetryOptions,
): Promise<Response> {
  return withRetry(
    async (signal) => {
      const resp = await fetch(url, { ...init, signal });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      return resp;
    },
    `fetch ${url}`,
    opts,
  );
}
