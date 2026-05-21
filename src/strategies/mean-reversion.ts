// MeanReversionStrategy: VWAP-based mean reversion on liquid index ETFs.
//
// Complementary to the ORB (momentum) strategy — they thrive in different
// regimes. ORB wins on trending mornings; mean-reversion wins on chop.
//
// Mechanics:
//   - Subscribe to SPY (and optionally QQQ) intraday
//   - Maintain a rolling N-bar VWAP (volume-weighted average price)
//   - When price deviates by > DEVIATION_THRESHOLD_PCT from VWAP, emit a
//     reversion signal:
//       price ABOVE VWAP by threshold -> SHORT
//       price BELOW VWAP by threshold -> LONG
//   - Stop: tight, at ADVERSE_STOP_PCT past entry
//   - Take: when price recovers to VWAP (or TAKE_PROFIT_PCT favorable move)
//   - Time stop: HOLD_MAX_MIN minutes
//   - Trading window: 10:00-15:00 ET (avoid open/close)
//   - Max 1 position open per symbol
//
// Why this works alongside ORB:
//   - Different regime fit (chop vs trend)
//   - Different timeframe (minutes vs hours)
//   - Different direction bias (counter-trend vs trend-following)
//   - Together they cover more of the trading day

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

const log = createLogger("mean-reversion");

const ACTIVE_START_MIN = 10 * 60;             // 10:00 ET
const ACTIVE_END_MIN = 15 * 60;               // 15:00 ET
const VWAP_WINDOW_BARS = 12;                  // 12 x 5-min = 1 hour
const DEVIATION_THRESHOLD_PCT = 0.20;         // 0.2% from VWAP triggers signal
const ADVERSE_STOP_PCT = 0.18;                // 0.18% past entry = stop
const TAKE_PROFIT_PCT = 0.30;                 // 0.3% in our favor = take
const HOLD_MAX_MIN = 15;                      // 15-minute max hold

interface BarSnapshot {
  readonly timestamp: number;
  readonly price: number;
  readonly volume: number;
}

interface SymbolState {
  readonly symbol: string;
  bars: BarSnapshot[];                        // recent bar history
  signalEmittedAt: number;                    // ms timestamp of last signal, for cooldown
  signalsToday: number;
  lastDate: string;
}

const MAX_SIGNALS_PER_SYMBOL_PER_DAY = 3;
const COOLDOWN_MS = 10 * 60 * 1000;           // 10-min cooldown between signals on same symbol

export class MeanReversionStrategy implements Strategy {
  readonly name = "mean-reversion";

  private readonly symbols: readonly string[];
  private state: Map<string, SymbolState> = new Map();
  private signalHandler: ((signal: TradeSignal) => void) | null = null;
  private getAccount: () => AccountSnapshot | null = () => null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly broker: Broker,
    symbols: readonly string[] = ["SPY", "QQQ"],
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
        bars: [],
        signalEmittedAt: 0,
        signalsToday: 0,
        lastDate: "",
      });
    }
    await this.broker.subscribeEquities(this.symbols);
    log.info("MeanReversion started", { symbols: this.symbols });
  }

  stop(): void {
    this.running = false;
    log.info("MeanReversion stopped");
  }

  handleEquityTick(ticks: readonly NormalizedTick[]): void {
    if (!this.running) return;
    for (const t of ticks) {
      const state = this.state.get(t.symbol);
      if (!state) continue;
      if (!Number.isFinite(t.last) || t.last <= 0) continue;

      const p = etParts(t.timestamp);
      const date = p.date;
      const minOfDay = p.hour * 60 + p.minute;

      // Reset daily state.
      if (date !== state.lastDate) {
        state.lastDate = date;
        state.signalsToday = 0;
        state.bars = [];
      }

      // Outside the active trading window.
      if (minOfDay < ACTIVE_START_MIN || minOfDay >= ACTIVE_END_MIN) {
        // Still accumulate bars so we have warmup ready when window opens.
        this.pushBar(state, t);
        continue;
      }

      this.pushBar(state, t);
      this.evaluate(state, t);
    }
  }

  // ----- Internals -----

  private pushBar(state: SymbolState, tick: NormalizedTick): void {
    state.bars.push({
      timestamp: tick.timestamp,
      price: tick.last,
      volume: tick.volume ?? 1,           // 1 if no volume to avoid div-by-zero
    });
    if (state.bars.length > VWAP_WINDOW_BARS * 4) {
      state.bars.shift();
    }
  }

  private evaluate(state: SymbolState, currentTick: NormalizedTick): void {
    if (state.signalsToday >= MAX_SIGNALS_PER_SYMBOL_PER_DAY) return;
    if (Date.now() - state.signalEmittedAt < COOLDOWN_MS) return;
    if (state.bars.length < VWAP_WINDOW_BARS) return;

    const recent = state.bars.slice(-VWAP_WINDOW_BARS);
    const sumPV = recent.reduce((s, b) => s + b.price * b.volume, 0);
    const sumV = recent.reduce((s, b) => s + b.volume, 0);
    if (sumV <= 0) return;
    const vwap = sumPV / sumV;

    const price = currentTick.last;
    const devPct = ((price - vwap) / vwap) * 100;
    const absDevPct = Math.abs(devPct);
    if (absDevPct < DEVIATION_THRESHOLD_PCT) return;

    const direction: "LONG" | "SHORT" = devPct > 0 ? "SHORT" : "LONG";
    const entry = price;
    const stopDist = entry * (ADVERSE_STOP_PCT / 100);
    const takeDist = entry * (TAKE_PROFIT_PCT / 100);
    const stop = direction === "LONG" ? entry - stopDist : entry + stopDist;
    const take = direction === "LONG" ? entry + takeDist : entry - takeDist;

    const account = this.getAccount();
    if (!account) return;

    const sized = sizeEquityPosition({
      accountEquity: account.equity,
      riskPerTradePct: this.config.maxRiskPerTradePct,
      entryPrice: entry,
      stopPrice: stop,
    });
    if (sized.shares <= 0) return;

    const inst: EquityInstrument = { assetClass: "equity", symbol: state.symbol };
    const signal: TradeSignal = {
      id: `mr-${state.symbol}-${currentTick.timestamp}`,
      strategy: "mean-reversion",
      timestamp: currentTick.timestamp,
      description: `${direction} ${state.symbol} @ ${entry.toFixed(2)} (VWAP ${vwap.toFixed(2)}, dev ${devPct.toFixed(2)}%)`,
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
      rewardUsd: sized.riskUsd * (TAKE_PROFIT_PCT / ADVERSE_STOP_PCT),
      metadata: {
        vwap,
        deviationPct: devPct,
        breakoutDirection: direction,
        entry,
        stop,
        take,
        holdMaxMin: HOLD_MAX_MIN,
      },
    };

    state.signalEmittedAt = Date.now();
    state.signalsToday++;
    log.info("MeanReversion signal", {
      symbol: state.symbol,
      direction,
      entry: entry.toFixed(2),
      vwap: vwap.toFixed(2),
      devPct: devPct.toFixed(2),
      shares: sized.shares,
    });
    this.signalHandler?.(signal);
  }
}
