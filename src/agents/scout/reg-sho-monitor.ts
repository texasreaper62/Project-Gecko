/**
 * SCOUT: Reg SHO Threshold List Monitor
 *
 * Checks NYSE and NASDAQ threshold lists daily.
 * When a stock appears on the list, forced buy-to-cover must happen
 * within 13 settlement days (SEC Rule 204).
 *
 * Data sources (free, public):
 * - NYSE: https://www.nyse.com/regulation/threshold-securities
 * - NASDAQ: https://www.nasdaqtrader.com/trader.aspx?id=regshothreshold
 */

import type { Opportunity } from '../../core/types.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('scout-regsho');

// Track stocks currently on the threshold list with their first-seen date
const thresholdListHistory: Map<string, { firstSeen: number; exchange: string; daysOnList: number }> = new Map();

// Track stocks we've already generated opportunities for
const notified: Set<string> = new Set();

interface ThresholdEntry {
  symbol: string;
  exchange: 'NYSE' | 'NASDAQ';
  date: string;
}

// ============================================================
// THRESHOLD LIST FETCHING
// ============================================================

async function fetchNyseThresholdList(): Promise<ThresholdEntry[]> {
  try {
    // NYSE publishes the threshold list daily as a text file
    const response = await fetch(
      'https://www.nyse.com/api/regulatory/threshold-securities/current',
      { headers: { 'User-Agent': 'ProjectGecko research@projectgecko.dev' } }
    );

    if (!response.ok) {
      log.warn('NYSE threshold list fetch failed', { status: response.status });
      return [];
    }

    const data = await response.json() as Array<{ symbolString: string; tradeDate: string }>;
    return data.map(entry => ({
      symbol: entry.symbolString,
      exchange: 'NYSE' as const,
      date: entry.tradeDate,
    }));
  } catch (err) {
    log.error('NYSE threshold list error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function fetchNasdaqThresholdList(): Promise<ThresholdEntry[]> {
  try {
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const response = await fetch(
      `https://api.nasdaq.com/api/quote/list-type/reg-sho-threshold?date=${today}`,
      {
        headers: {
          'User-Agent': 'ProjectGecko research@projectgecko.dev',
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      log.warn('NASDAQ threshold list fetch failed', { status: response.status });
      return [];
    }

    const data = await response.json() as {
      data?: { rows?: Array<{ symbol: string; date: string }> }
    };

    return (data?.data?.rows ?? []).map(row => ({
      symbol: row.symbol,
      exchange: 'NASDAQ' as const,
      date: row.date,
    }));
  } catch (err) {
    log.error('NASDAQ threshold list error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ============================================================
// MAIN SCAN
// ============================================================

export async function scanThresholdList(): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];

  const nyse = await fetchNyseThresholdList();
  const nasdaq = await fetchNasdaqThresholdList();
  const allEntries = [...nyse, ...nasdaq];

  const currentSymbols = new Set<string>();

  for (const entry of allEntries) {
    currentSymbols.add(entry.symbol);

    if (!thresholdListHistory.has(entry.symbol)) {
      // New addition to threshold list
      thresholdListHistory.set(entry.symbol, {
        firstSeen: Date.now(),
        exchange: entry.exchange,
        daysOnList: 1,
      });
    } else {
      // Already on list, increment days
      const existing = thresholdListHistory.get(entry.symbol)!;
      existing.daysOnList++;
    }

    // Generate opportunity if new and not already notified
    if (!notified.has(entry.symbol)) {
      notified.add(entry.symbol);

      opportunities.push({
        id: `regsho-${entry.symbol}-${Date.now()}`,
        type: 'REG_SHO',
        ticker: entry.symbol,
        urgency: 'TODAY',
        detectedAt: Date.now(),
        data: {
          exchange: entry.exchange,
          daysOnList: 1,
          maxForcedCoverDays: 13,
          remainingDays: 13,
        },
        summary: `${entry.symbol} added to Reg SHO threshold list (${entry.exchange}). Forced covering within 13 days.`,
      });

      log.info(`New threshold list entry: ${entry.symbol}`, {
        exchange: entry.exchange,
      });
    }
  }

  // Clean up stocks that have been removed from the list
  for (const [symbol] of thresholdListHistory) {
    if (!currentSymbols.has(symbol)) {
      thresholdListHistory.delete(symbol);
      notified.delete(symbol);
      log.info(`${symbol} removed from threshold list`);
    }
  }

  return opportunities;
}

export function getThresholdListStatus(): Map<string, { firstSeen: number; exchange: string; daysOnList: number }> {
  return new Map(thresholdListHistory);
}
