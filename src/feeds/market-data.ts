/**
 * Market data module -- gets real quotes for tickers.
 *
 * Uses Yahoo Finance v8 API (free, no auth, decent rate limits).
 * Falls back to a static estimate if fetch fails.
 *
 * In production on the VPS this will hit Yahoo directly.
 * In dev behind proxy it will return nulls and the analyst
 * uses conservative fallback sizing.
 */

import { createLogger } from '../core/logger.js';
import type { VerifiedFact } from '../core/types.js';
import { createFact } from '../core/types.js';

const log = createLogger('market-data');

export interface Quote {
  symbol: string;
  price: number;
  marketCap: number;
  volume: number;
  previousClose: number;
  changePercent: number;
}

const quoteCache: Map<string, { quote: Quote; fetchedAt: number }> = new Map();
const CACHE_TTL_MS = 30_000;

export async function getQuote(symbol: string): Promise<VerifiedFact<Quote> | null> {
  const cached = quoteCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return createFact(cached.quote, 'yahoo-cache', 'verified', CACHE_TTL_MS);
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'ProjectGecko/2.0' },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      log.debug('Quote fetch failed', { symbol, status: response.status });
      return null;
    }

    const data = await response.json() as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            previousClose?: number;
            marketCap?: number;
            regularMarketVolume?: number;
          };
        }>;
      };
    };

    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) {
      log.debug('No price data in response', { symbol });
      return null;
    }

    const quote: Quote = {
      symbol,
      price: meta.regularMarketPrice,
      marketCap: meta.marketCap ?? 0,
      volume: meta.regularMarketVolume ?? 0,
      previousClose: meta.previousClose ?? meta.regularMarketPrice,
      changePercent: meta.previousClose
        ? ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100
        : 0,
    };

    quoteCache.set(symbol, { quote, fetchedAt: Date.now() });

    return createFact(quote, 'yahoo', 'verified', CACHE_TTL_MS);
  } catch (err) {
    log.debug('Quote fetch error', {
      symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function getBatchQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const results = new Map<string, Quote>();
  for (const sym of symbols) {
    const fact = await getQuote(sym);
    if (fact) results.set(sym, fact.value);
  }
  return results;
}

export function clearQuoteCache(): void {
  quoteCache.clear();
}
