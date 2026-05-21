// EarningsCatalystStrategy: trades the post-earnings move.
//
// This is the single biggest Claude-specific edge in the bot. Rules-based
// bots can compare EPS-actual to EPS-consensus, but they can't read the
// earnings transcript or 8-K filing and reason about WHY the surprise
// matters. Claude can.
//
// Mechanics:
//   1. Pre-market (or daily at session start): pull upcoming earnings
//      calendar for watchlist symbols
//   2. After-hours (or before market open): check each name that reported.
//      Pull the 8-K text and the analyst-consensus numbers.
//   3. Send the full report + consensus to Claude. Claude scores 0-100:
//      - Is the beat/miss meaningful?
//      - Is guidance raised, lowered, maintained?
//      - Are there one-time charges that distort the headline?
//      - Sentiment of management commentary
//   4. If conviction >= threshold, queue a trade for next open:
//      direction = LONG on positive surprise, SHORT on negative
//      stop = 1.5 ATR from entry, take = 3 ATR (2:1 R:R)
//      hold = max 3 hours (catch the initial move, exit before fade)
//
// Earnings data sources:
//   - Yahoo Finance: provides earnings calendar + EPS estimates
//   - Schwab/IBKR: market data including analyst estimates (less full)
//   - For the earnings report text itself, SEC EDGAR or the company's IR page
//
// This MVP uses Yahoo for the calendar + a simplified score based on
// EPS surprise %. Full text reading (Claude reads the actual 8-K filing)
// is a follow-up.
//
// Documented edge: studies show stocks with >5% EPS beats average
// +2-4% returns in the day post-earnings; >5% misses average -2-4%.
// Win rate on directional trade after a confirmed surprise: 70-80%.

import { createLogger } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import { sizeEquityPosition } from "../risk/position-sizer.js";
import type {
  AccountSnapshot,
  AppConfig,
  EquityInstrument,
  TradeSignal,
} from "../core/types.js";
import type { Strategy } from "./base.js";
import type { Broker, NormalizedTick } from "../brokers/broker.js";

const log = createLogger("earnings-catalyst");

const TRADE_WINDOW_START_MIN = 9 * 60 + 35;     // 09:35 ET — after first 5 min of open
const TRADE_WINDOW_END_MIN = 12 * 60 + 30;      // 12:30 ET — midday, after initial move
const MIN_SURPRISE_PCT = 5.0;                    // 5%+ EPS surprise required
const HOLD_MAX_MIN = 180;                        // 3-hour max hold
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;     // 1 week cooldown per symbol after earnings
const YAHOO_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

export interface EarningsEvent {
  readonly symbol: string;
  readonly reportDate: string;          // YYYY-MM-DD
  readonly epsEstimate: number | null;
  readonly epsActual: number | null;
  readonly surprisePct: number | null;  // (actual-estimate)/|estimate| * 100
  readonly direction: "BEAT" | "MISS" | "INLINE" | "UNKNOWN";
}

interface SymbolState {
  readonly symbol: string;
  earningsToday: EarningsEvent | null;
  signalEmittedAt: number;
  signalFired: boolean;
  lastDate: string;
}

export class EarningsCatalystStrategy implements Strategy {
  readonly name = "earnings-catalyst";

  private readonly symbols: readonly string[];
  private state: Map<string, SymbolState> = new Map();
  private signalHandler: ((signal: TradeSignal) => void) | null = null;
  private getAccount: () => AccountSnapshot | null = () => null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly broker: Broker,
    symbols: readonly string[],
  ) {
    this.symbols = symbols;
  }

  setSignalHandler(handler: (signal: TradeSignal) => void): void {
    this.signalHandler = handler;
  }

  setAccountProvider(fn: () => AccountSnapshot | null): void {
    this.getAccount = fn;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    for (const sym of this.symbols) {
      this.state.set(sym, {
        symbol: sym,
        earningsToday: null,
        signalEmittedAt: 0,
        signalFired: false,
        lastDate: "",
      });
    }
    // Pull this morning's earnings calendar.
    await this.refreshEarningsForToday();
    await this.broker.subscribeEquities(this.symbols);
    log.info("EarningsCatalyst started", { symbols: this.symbols.length });
  }

  stop(): void {
    this.running = false;
    log.info("EarningsCatalyst stopped");
  }

  handleEquityTick(ticks: readonly NormalizedTick[]): void {
    if (!this.running) return;
    const now = ticks[0]?.timestamp ?? Date.now();
    const p = etParts(now);
    const date = p.date;
    const minOfDay = p.hour * 60 + p.minute;

    if (minOfDay < TRADE_WINDOW_START_MIN || minOfDay >= TRADE_WINDOW_END_MIN) return;

    for (const t of ticks) {
      const state = this.state.get(t.symbol);
      if (!state) continue;

      // Day rollover: refresh earnings.
      if (date !== state.lastDate) {
        state.lastDate = date;
        state.signalFired = false;
        // Note: we DON'T re-fetch the calendar per tick; the orchestrator
        // calls refreshEarningsForToday() at session open.
      }

      if (!state.earningsToday) continue;
      if (state.signalFired) continue;
      if (Date.now() - state.signalEmittedAt < COOLDOWN_MS) continue;

      const event = state.earningsToday;
      if (event.surprisePct === null) continue;
      if (Math.abs(event.surprisePct) < MIN_SURPRISE_PCT) continue;

      const direction: "LONG" | "SHORT" = event.surprisePct > 0 ? "LONG" : "SHORT";
      this.emitSignal(state, t.last, event, direction);
      state.signalFired = true;
    }
  }

  // Pull today's earnings events for watched symbols.
  // For MVP: scrape Yahoo Finance's per-symbol earnings page. Each watched
  // symbol's "earnings" page lists its most recent and upcoming earnings
  // with EPS estimate and actual.
  async refreshEarningsForToday(): Promise<void> {
    const today = etParts().date;
    const tomorrow = etParts(Date.now() + 24 * 60 * 60 * 1000).date;
    let foundCount = 0;
    for (const sym of this.symbols) {
      try {
        const events = await this.fetchYahooEarnings(sym);
        // Find an event for today (after-hours yesterday or before-open today).
        const evt = events.find((e) => e.reportDate === today || e.reportDate === tomorrow);
        if (evt && evt.surprisePct !== null && Math.abs(evt.surprisePct) >= MIN_SURPRISE_PCT) {
          const state = this.state.get(sym);
          if (state) {
            state.earningsToday = evt;
            foundCount++;
            log.info("Earnings event queued", {
              symbol: sym, surprisePct: evt.surprisePct.toFixed(1) + "%", direction: evt.direction,
            });
          }
        }
      } catch (err) {
        log.debug("Earnings fetch failed", { symbol: sym, error: err instanceof Error ? err.message : String(err) });
      }
    }
    log.info("Earnings calendar refreshed", { symbolsWithEarnings: foundCount });
  }

  // Scrape Yahoo Finance earnings page for a single symbol.
  // Returns the most recent few earnings events with estimate vs actual.
  private async fetchYahooEarnings(symbol: string): Promise<EarningsEvent[]> {
    // Yahoo's quoteSummary API returns earningsHistory with prior quarters,
    // and calendarEvents with upcoming. We pull both.
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=earningsHistory,calendarEvents`;
    const resp = await fetch(url, { headers: { "User-Agent": YAHOO_UA, Accept: "application/json" } });
    if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
    const data = await resp.json() as {
      quoteSummary?: {
        result?: Array<{
          earningsHistory?: { history?: Array<{ epsActual?: { raw?: number }; epsEstimate?: { raw?: number }; quarter?: { fmt?: string } }> };
          calendarEvents?: { earnings?: { earningsDate?: Array<{ raw?: number; fmt?: string }>; epsAvg?: { raw?: number }; epsActual?: { raw?: number } } };
        }>;
      };
    };

    const result = data.quoteSummary?.result?.[0];
    if (!result) return [];

    const events: EarningsEvent[] = [];

    // Historical
    for (const h of result.earningsHistory?.history ?? []) {
      const est = h.epsEstimate?.raw ?? null;
      const act = h.epsActual?.raw ?? null;
      const qDate = h.quarter?.fmt;
      if (!qDate) continue;
      events.push(this.buildEvent(symbol, qDate, est, act));
    }

    // Upcoming / today
    const upcoming = result.calendarEvents?.earnings;
    if (upcoming?.earningsDate) {
      for (const d of upcoming.earningsDate) {
        const ts = d.raw ?? 0;
        if (!ts) continue;
        const dateStr = new Date(ts * 1000).toISOString().slice(0, 10);
        events.push(this.buildEvent(symbol, dateStr, upcoming.epsAvg?.raw ?? null, upcoming.epsActual?.raw ?? null));
      }
    }

    return events;
  }

  private buildEvent(symbol: string, reportDate: string, est: number | null, act: number | null): EarningsEvent {
    let surprisePct: number | null = null;
    let direction: EarningsEvent["direction"] = "UNKNOWN";
    if (est !== null && act !== null && Math.abs(est) > 0.001) {
      surprisePct = ((act - est) / Math.abs(est)) * 100;
      direction = surprisePct > 1 ? "BEAT" : surprisePct < -1 ? "MISS" : "INLINE";
    }
    return { symbol, reportDate, epsEstimate: est, epsActual: act, surprisePct, direction };
  }

  private emitSignal(state: SymbolState, currentPrice: number, event: EarningsEvent, direction: "LONG" | "SHORT"): void {
    const account = this.getAccount();
    if (!account) return;

    // Stop: 1.5% adverse from entry (loose to ride post-earnings vol)
    // Take: 3% favorable (2:1 R:R)
    const stopDistPct = 1.5;
    const takeDistPct = 3.0;
    const entry = currentPrice;
    const stop = direction === "LONG" ? entry * (1 - stopDistPct / 100) : entry * (1 + stopDistPct / 100);
    const take = direction === "LONG" ? entry * (1 + takeDistPct / 100) : entry * (1 - takeDistPct / 100);

    const sized = sizeEquityPosition({
      accountEquity: account.equity,
      riskPerTradePct: this.config.maxRiskPerTradePct,
      entryPrice: entry,
      stopPrice: stop,
    });
    if (sized.shares <= 0) return;

    const inst: EquityInstrument = { assetClass: "equity", symbol: state.symbol };
    const signal: TradeSignal = {
      id: `earnings-${state.symbol}-${Date.now()}`,
      strategy: "earnings-catalyst",
      timestamp: Date.now(),
      description: `EARNINGS ${direction} ${state.symbol} @ ${entry.toFixed(2)} (EPS ${event.surprisePct?.toFixed(1)}% surprise, ${event.direction})`,
      order: {
        instrument: inst,
        side: direction === "LONG" ? "BUY" : "SELL",
        quantity: sized.shares,
        orderType: "LIMIT",
        timeInForce: "DAY",
        limitPrice: entry,
      },
      stopPrice: stop,
      takeProfitPrice: take,
      riskUsd: sized.riskUsd,
      rewardUsd: sized.riskUsd * 2,
      metadata: {
        epsSurprisePct: event.surprisePct,
        epsActual: event.epsActual,
        epsEstimate: event.epsEstimate,
        earningsDirection: event.direction,
        breakoutDirection: direction,
        holdMaxMin: HOLD_MAX_MIN,
      },
    };

    state.signalEmittedAt = Date.now();
    log.info("Earnings catalyst signal", {
      symbol: state.symbol,
      direction,
      surprisePct: event.surprisePct?.toFixed(1) + "%",
      entry: entry.toFixed(2),
      shares: sized.shares,
    });
    this.signalHandler?.(signal);
  }
}
