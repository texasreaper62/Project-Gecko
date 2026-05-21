// Engine A: Opening Range Breakout (equities).
//
// Lifecycle:
//   pre-09:30 ET: Scanner provides today's candidates. We subscribe each to
//                 LEVELONE_EQUITIES.
//   09:30-09:45:  Track high/low of each candidate (the "opening range").
//   09:45-11:30:  On 1-min close above range high (long) or below range low
//                 (short), emit a TradeSignal with stop and take-profit at 2R.
//   11:30 ET:     Stop generating new signals. Open positions managed by the
//                 position-monitor (separate concern), not this strategy.
//
// Risk per trade:
//   risk_usd  = account_equity * MAX_RISK_PER_TRADE_PCT / 100
//   stop      = OR low (long) or OR high (short)
//   shares    = floor(risk_usd / |entry - stop|)
//   take      = entry + 2 * (entry - stop)  (long, symmetric for short)
//
// Hard constraints baked in here (matching CLAUDE.md):
//   - Max 1 signal per symbol per day
//   - Skip OR width < 0.5% of price (no momentum)
//   - Skip OR width > 5% of price (bad R:R)

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
import type { GapCandidate } from "../scanner/premarket.js";
import type { Broker, NormalizedTick } from "../brokers/broker.js";
import type { EconomicCalendar } from "../intelligence/economic-calendar.js";

const log = createLogger("orb");

const OR_START_MIN = 9 * 60 + 30;       // 09:30 ET
const OR_END_MIN = 9 * 60 + 45;         // 09:45 ET
const TRADE_CUTOFF_MIN = 11 * 60 + 30;  // 11:30 ET
const OR_MIN_WIDTH_PCT = 0.5;
const OR_MAX_WIDTH_PCT = 5.0;
const SCAN_INTERVAL_MS = 1_000;
const RR_TARGET = 2;                    // take-profit at 2R

interface CandidateState {
  readonly symbol: string;
  readonly direction: "UP" | "DOWN";    // from premarket gap (preferred side)
  readonly gapPct: number;
  orHigh: number;
  orLow: number;
  lastPrice: number;
  // Closed-bar tracking (1-minute closes drive the trigger).
  currentMinuteStart: number;           // ET minute boundary in ms
  currentMinuteHigh: number;
  currentMinuteLow: number;
  currentMinuteClose: number;
  signalEmitted: boolean;
}

// Field IDs used in LEVELONE_EQUITIES content blocks. Schwab returns fields
// as numeric-string keys. We map a few core ones:
//   "0" symbol
//   "1" bid
//   "2" ask
//   "3" last
//   "8" totalVolume
//   "35" quoteTime (ms)
//   "36" tradeTime (ms)
//   "38" mark

export class OrbStrategy implements Strategy {
  readonly name = "orb";

  private candidates: Map<string, CandidateState> = new Map();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private signalHandler: ((signal: TradeSignal) => void) | null = null;
  private getAccount: () => AccountSnapshot | null = () => null;

  constructor(
    private readonly config: AppConfig,
    private readonly broker: Broker,
  ) {}

  setSignalHandler(handler: (signal: TradeSignal) => void): void {
    this.signalHandler = handler;
  }

  setAccountProvider(fn: () => AccountSnapshot | null): void {
    this.getAccount = fn;
  }

  // Optional economic calendar; when present, ORB skips signals on macro days.
  private calendar: EconomicCalendar | null = null;
  setEconomicCalendar(cal: EconomicCalendar): void {
    this.calendar = cal;
  }

  // Seed with today's candidates from the premarket scanner. Should be called
  // before 09:30 ET. Subscribes to live ticks for each.
  loadCandidates(candidates: readonly GapCandidate[]): void {
    // Skip the day entirely if it's a high-impact macro release day.
    if (this.calendar?.shouldSkipOrb()) {
      log.info("ORB skipping macro release day", {
        events: this.calendar.eventsOn().map((e) => e.type),
      });
      this.candidates.clear();
      return;
    }
    this.candidates.clear();
    const symbols: string[] = [];
    for (const c of candidates) {
      const sym = c.instrument.symbol.toUpperCase();
      this.candidates.set(sym, {
        symbol: sym,
        direction: c.direction,
        gapPct: c.gapPct,
        orHigh: -Infinity,
        orLow: Infinity,
        lastPrice: c.premarketPrice,
        currentMinuteStart: 0,
        currentMinuteHigh: -Infinity,
        currentMinuteLow: Infinity,
        currentMinuteClose: c.premarketPrice,
        signalEmitted: false,
      });
      symbols.push(sym);
    }
    if (symbols.length > 0) {
      this.broker.subscribeEquities(symbols).catch((err) => {
        log.error("subscribeEquities failed", { error: err instanceof Error ? err.message : String(err) });
      });
      log.info("ORB candidates loaded", { count: symbols.length, symbols });
    }
  }

  async start(): Promise<void> {
    // Drive the strategy off the stream's data handler. We register a
    // tick-router below; the actual entry-check happens on a 1s timer that
    // closes the current 1-min bar at minute boundaries.
    this.scanTimer = setInterval(() => {
      this.tick();
    }, SCAN_INTERVAL_MS);
    log.info("ORB started");
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    log.info("ORB stopped");
  }

  // Wired by the orchestrator: every equity tick from the broker stream
  // routes through here as a NormalizedTick (broker-agnostic shape).
  handleEquityTick(ticks: readonly NormalizedTick[]): void {
    for (const t of ticks) {
      const state = this.candidates.get(t.symbol);
      if (!state) continue;
      if (!Number.isFinite(t.last) || t.last <= 0) continue;
      state.lastPrice = t.last;
      this.aggregateMinute(state, t.last);
    }
  }

  // ----- Internals -----

  private aggregateMinute(state: CandidateState, price: number): void {
    const now = Date.now();
    const minuteStart = Math.floor(now / 60_000) * 60_000;

    if (state.currentMinuteStart === 0) {
      state.currentMinuteStart = minuteStart;
      state.currentMinuteHigh = price;
      state.currentMinuteLow = price;
      state.currentMinuteClose = price;
      return;
    }

    if (minuteStart > state.currentMinuteStart) {
      // Minute boundary just closed. Apply OR / trigger logic to the just-
      // closed minute, then start a new one.
      this.onMinuteClose(state);
      state.currentMinuteStart = minuteStart;
      state.currentMinuteHigh = price;
      state.currentMinuteLow = price;
      state.currentMinuteClose = price;
      return;
    }

    if (price > state.currentMinuteHigh) state.currentMinuteHigh = price;
    if (price < state.currentMinuteLow) state.currentMinuteLow = price;
    state.currentMinuteClose = price;
  }

  // Called on a 1s tick; mainly forces the just-closed minute to be applied
  // even when the stream is quiet at a minute boundary.
  private tick(): void {
    const now = Date.now();
    const minuteStart = Math.floor(now / 60_000) * 60_000;
    for (const state of this.candidates.values()) {
      if (state.currentMinuteStart > 0 && minuteStart > state.currentMinuteStart) {
        this.onMinuteClose(state);
        // Reset to current minute boundary; close becomes opening tick of new bar.
        state.currentMinuteStart = minuteStart;
        state.currentMinuteHigh = state.lastPrice;
        state.currentMinuteLow = state.lastPrice;
        state.currentMinuteClose = state.lastPrice;
      }
    }
  }

  private onMinuteClose(state: CandidateState): void {
    const p = etParts(state.currentMinuteStart);
    const mins = p.hour * 60 + p.minute;

    // Window 1: building the opening range (09:30 - 09:45).
    if (mins >= OR_START_MIN && mins < OR_END_MIN) {
      if (state.currentMinuteHigh > state.orHigh) state.orHigh = state.currentMinuteHigh;
      if (state.currentMinuteLow < state.orLow) state.orLow = state.currentMinuteLow;
      return;
    }

    // Window 2: scanning for breakouts (09:45 - 11:30).
    if (mins < OR_END_MIN || mins >= TRADE_CUTOFF_MIN) return;
    if (state.signalEmitted) return;
    if (!Number.isFinite(state.orHigh) || !Number.isFinite(state.orLow)) return;

    const midpoint = (state.orHigh + state.orLow) / 2;
    const orWidthPct = midpoint > 0 ? (state.orHigh - state.orLow) / midpoint * 100 : 0;
    if (orWidthPct < OR_MIN_WIDTH_PCT) return;
    if (orWidthPct > OR_MAX_WIDTH_PCT) return;

    const close = state.currentMinuteClose;
    let direction: "LONG" | "SHORT" | null = null;
    if (close > state.orHigh) direction = "LONG";
    else if (close < state.orLow) direction = "SHORT";
    if (!direction) return;

    // Build the trade signal.
    const entry = close;
    const stop = direction === "LONG" ? state.orLow : state.orHigh;
    const stopDist = Math.abs(entry - stop);
    if (stopDist <= 0) return;

    const account = this.getAccount();
    if (!account) {
      log.warn("ORB trigger but no account snapshot available", { symbol: state.symbol });
      return;
    }

    const sized = sizeEquityPosition({
      accountEquity: account.equity,
      riskPerTradePct: this.config.maxRiskPerTradePct,
      entryPrice: entry,
      stopPrice: stop,
    });
    if (sized.shares <= 0) {
      log.info("ORB trigger but size=0, skipping", {
        symbol: state.symbol,
        entry,
        stop,
        accountEquity: account.equity,
      });
      state.signalEmitted = true;
      return;
    }

    const take = direction === "LONG"
      ? entry + RR_TARGET * stopDist
      : entry - RR_TARGET * stopDist;

    const instrument: EquityInstrument = { assetClass: "equity", symbol: state.symbol };
    const signal: TradeSignal = {
      id: `orb-${state.symbol}-${Date.now()}`,
      strategy: "orb",
      timestamp: Date.now(),
      description: `${direction} ${state.symbol} @ ${entry.toFixed(2)} (OR ${state.orLow.toFixed(2)}-${state.orHigh.toFixed(2)}, ${orWidthPct.toFixed(2)}%, gap ${state.gapPct.toFixed(1)}%)`,
      order: {
        instrument,
        side: direction === "LONG" ? "BUY" : "SELL",
        quantity: sized.shares,
        orderType: "LIMIT",
        timeInForce: "DAY",
        limitPrice: entry,
      },
      stopPrice: stop,
      takeProfitPrice: take,
      riskUsd: sized.riskUsd,
      rewardUsd: sized.riskUsd * RR_TARGET,
      metadata: {
        orHigh: state.orHigh,
        orLow: state.orLow,
        orWidthPct,
        gapPct: state.gapPct,
        premarketDirection: state.direction,
        entry,
        stop,
        take,
        breakoutDirection: direction,
      },
    };

    state.signalEmitted = true;
    log.info("ORB signal", {
      symbol: state.symbol,
      direction,
      entry: entry.toFixed(2),
      stop: stop.toFixed(2),
      take: take.toFixed(2),
      shares: sized.shares,
      riskUsd: sized.riskUsd.toFixed(2),
    });
    this.signalHandler?.(signal);
  }
}
