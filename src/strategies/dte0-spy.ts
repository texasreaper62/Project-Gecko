// Engine B: 0DTE SPY directional scalping.
//
// Flow:
//   09:30 ET: pull today's SPY 0DTE chain, identify ATM call + ATM put.
//             Subscribe to LEVELONE_EQUITIES for SPY and LEVELONE_OPTIONS
//             for both contracts.
//   09:30-10:30: track SPY 1-min closes, opening price (first 9:30 tick).
//                If SPY moves >= 1% from open in either direction, the
//                trigger is armed for that direction.
//   10:30+: if armed, wait for a pullback to the 5-min VWAP in the trend
//           direction. On a bounce-off-VWAP candle, emit a BUY signal on
//           the ATM call (uptrend) or ATM put (downtrend).
//   Constraints: max 1 contract per signal, max 2 signals per day, max 2
//                concurrent open. 14:00 ET hard cutoff for new signals.
//
// Exit logic (managed by position-monitor, not this strategy):
//   +50% gain, -50% loss, 30 min no movement, 14:00 ET time-stop.
//
// What's missing vs CLAUDE.md:
//   - Breadth confirmation (NYSE TICK / advance-decline). Schwab does not
//     expose this cleanly via the API; we accept the 1% move alone for MVP.
//   - FOMC/CPI calendar disable. Operator should set DTE0_ENABLED=false
//     manually on those days until we wire an econ calendar feed.

import { createLogger } from "../core/logger.js";
import { etParts } from "../utils/time.js";
import { sizeOptionPosition } from "../risk/position-sizer.js";
import type {
  AccountSnapshot,
  AppConfig,
  OptionInstrument,
  TradeSignal,
} from "../core/types.js";
import type { Strategy } from "./base.js";
import type { Broker, NormalizedTick } from "../brokers/broker.js";
import type { OptionsChainMonitor, AtmPair } from "../scanner/options-chain.js";

const log = createLogger("dte0-spy");

const TRIGGER_WINDOW_START_MIN = 9 * 60 + 30;   // 09:30
const TRIGGER_WINDOW_END_MIN = 10 * 60 + 30;    // 10:30 (after this, only entries)
const TRADE_CUTOFF_MIN = 14 * 60;                // 14:00 hard stop
const TRIGGER_MOVE_PCT = 1.0;                    // 1% SPY move arms trigger
const VWAP_PROXIMITY_PCT = 0.1;                  // within 0.1% of 5-min VWAP = "at" VWAP
const TICK_SCAN_MS = 1_000;


interface FiveMinBar {
  readonly start: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class Dte0SpyStrategy implements Strategy {
  readonly name = "dte0-spy";

  private chain: AtmPair | null = null;
  private spyOpen = 0;
  private spyLast = 0;
  private triggerArmed: "LONG" | "SHORT" | null = null;
  private signalsToday = 0;
  private signalEmittedFor: { LONG: boolean; SHORT: boolean } = { LONG: false, SHORT: false };

  // Rolling 5-min bars for VWAP calc (we use last 12 = 60 minutes back).
  private bars: FiveMinBar[] = [];
  private currentBar: FiveMinBar | null = null;

  // Option mid prices (mark) from the option stream.
  private callMark = 0;
  private putMark = 0;

  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private signalHandler: ((signal: TradeSignal) => void) | null = null;
  private getAccount: () => AccountSnapshot | null = () => null;

  constructor(
    private readonly config: AppConfig,
    private readonly broker: Broker,
    private readonly chainMonitor: OptionsChainMonitor,
  ) {}

  setSignalHandler(handler: (signal: TradeSignal) => void): void {
    this.signalHandler = handler;
  }

  setAccountProvider(fn: () => AccountSnapshot | null): void {
    this.getAccount = fn;
  }

  async start(): Promise<void> {
    // Pull today's 0DTE chain and arm subscriptions.
    this.chain = await this.chainMonitor.getZeroDtePair("SPY");
    if (!this.chain) {
      log.warn("Engine B not starting: no 0DTE SPY chain available today");
      return;
    }

    await this.broker.subscribeEquities(["SPY"]);
    await this.broker.subscribeOptions([this.chain.call.instrument.osiSymbol, this.chain.put.instrument.osiSymbol]);

    log.info("Engine B armed", {
      underlying: this.chain.underlyingPrice,
      expiration: this.chain.expiration,
      callStrike: this.chain.call.instrument.strike,
      callMid: this.chain.call.mid,
      putStrike: this.chain.put.instrument.strike,
      putMid: this.chain.put.mid,
    });

    this.scanTimer = setInterval(() => this.tick(), TICK_SCAN_MS);
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  handleEquityTick(ticks: readonly NormalizedTick[]): void {
    for (const t of ticks) {
      if (t.symbol !== "SPY" || !Number.isFinite(t.last) || t.last <= 0) continue;
      if (this.spyOpen === 0) this.spyOpen = t.last;
      this.spyLast = t.last;
      this.aggregateBar(t.last);
    }
  }

  handleOptionTick(ticks: readonly NormalizedTick[]): void {
    if (!this.chain) return;
    for (const t of ticks) {
      // Prefer mid (bid+ask)/2 if both present, else mark (carried in t.last
      // by the SchwabBroker normalization).
      const mid = t.bid !== undefined && t.ask !== undefined && t.bid > 0 && t.ask > 0
        ? (t.bid + t.ask) / 2
        : t.last;
      if (!Number.isFinite(mid) || mid <= 0) continue;
      if (t.symbol === this.chain.call.instrument.osiSymbol) this.callMark = mid;
      else if (t.symbol === this.chain.put.instrument.osiSymbol) this.putMark = mid;
    }
  }

  // ----- Internals -----

  private aggregateBar(price: number): void {
    const now = Date.now();
    const fiveMinStart = Math.floor(now / 300_000) * 300_000;

    if (!this.currentBar) {
      this.currentBar = { start: fiveMinStart, high: price, low: price, close: price, volume: 0 };
      return;
    }

    if (fiveMinStart > this.currentBar.start) {
      this.bars.push(this.currentBar);
      if (this.bars.length > 12) this.bars.shift();
      this.currentBar = { start: fiveMinStart, high: price, low: price, close: price, volume: 0 };
      return;
    }

    if (price > this.currentBar.high) this.currentBar.high = price;
    if (price < this.currentBar.low) this.currentBar.low = price;
    this.currentBar.close = price;
  }

  private tick(): void {
    if (!this.chain || this.spyLast === 0 || this.spyOpen === 0) return;

    const p = etParts();
    const mins = p.hour * 60 + p.minute;
    if (mins < TRIGGER_WINDOW_START_MIN || mins >= TRADE_CUTOFF_MIN) return;

    // Arm trigger inside the 9:30-10:30 window.
    if (mins < TRIGGER_WINDOW_END_MIN && this.triggerArmed === null) {
      const movePct = (this.spyLast - this.spyOpen) / this.spyOpen * 100;
      if (movePct >= TRIGGER_MOVE_PCT) {
        this.triggerArmed = "LONG";
        log.info("Engine B trigger armed", { direction: "LONG", spyOpen: this.spyOpen, spyLast: this.spyLast, movePct: movePct.toFixed(2) });
      } else if (movePct <= -TRIGGER_MOVE_PCT) {
        this.triggerArmed = "SHORT";
        log.info("Engine B trigger armed", { direction: "SHORT", spyOpen: this.spyOpen, spyLast: this.spyLast, movePct: movePct.toFixed(2) });
      }
    }

    if (this.triggerArmed === null) return;
    if (this.signalsToday >= this.config.dte0MaxTradesPerDay) return;
    if (this.signalEmittedFor[this.triggerArmed]) return;

    // VWAP pullback check.
    const vwap = this.computeVwap();
    if (!Number.isFinite(vwap) || vwap <= 0) return;

    const distFromVwapPct = (this.spyLast - vwap) / vwap * 100;
    const atVwap = Math.abs(distFromVwapPct) <= VWAP_PROXIMITY_PCT;
    if (!atVwap) return;

    // Bounce confirmation: current bar's close on the trend side of VWAP.
    const bar = this.currentBar;
    if (!bar) return;
    if (this.triggerArmed === "LONG" && bar.close < vwap) return;
    if (this.triggerArmed === "SHORT" && bar.close > vwap) return;

    this.emitSignal(this.triggerArmed, vwap);
  }

  private emitSignal(direction: "LONG" | "SHORT", vwap: number): void {
    if (!this.chain) return;

    const account = this.getAccount();
    if (!account) {
      log.warn("Engine B trigger but no account snapshot");
      return;
    }

    const contract = direction === "LONG" ? this.chain.call : this.chain.put;
    const premium = direction === "LONG"
      ? (this.callMark > 0 ? this.callMark : contract.mid)
      : (this.putMark > 0 ? this.putMark : contract.mid);
    if (!Number.isFinite(premium) || premium <= 0) {
      log.warn("Engine B trigger but premium unavailable", { direction });
      return;
    }

    // Engine B caps contract count tightly. Use position sizer to get a
    // baseline, then clamp to config.dte0MaxContractsPerTrade.
    const sized = sizeOptionPosition({
      accountEquity: account.equity,
      riskPerTradePct: this.config.maxRiskPerTradePct,
      premiumPerContract: premium,
    });
    const contracts = Math.min(sized.contracts, this.config.dte0MaxContractsPerTrade);
    if (contracts <= 0) {
      log.info("Engine B trigger but size=0", {
        direction,
        premium,
        accountEquity: account.equity,
      });
      this.signalEmittedFor[direction] = true;
      return;
    }

    const inst: OptionInstrument = contract.instrument;
    const limitPrice = roundOptionTick(premium);

    const signal: TradeSignal = {
      id: `dte0-${direction}-${Date.now()}`,
      strategy: "dte0-spy",
      timestamp: Date.now(),
      description: `${direction} SPY 0DTE ${inst.optionType} ${inst.strike} @ $${limitPrice.toFixed(2)} (SPY ${this.spyLast.toFixed(2)}, vwap ${vwap.toFixed(2)})`,
      order: {
        instrument: inst,
        side: "BUY_TO_OPEN",
        quantity: contracts,
        orderType: "LIMIT",
        timeInForce: "DAY",
        limitPrice,
      },
      stopPrice: limitPrice * 0.5,           // -50% premium
      takeProfitPrice: limitPrice * 1.5,     // +50% premium
      riskUsd: limitPrice * 100 * contracts * 0.5,
      rewardUsd: limitPrice * 100 * contracts * 0.5,
      metadata: {
        direction,
        spyOpen: this.spyOpen,
        spyLast: this.spyLast,
        movePct: (this.spyLast - this.spyOpen) / this.spyOpen * 100,
        vwap,
        premium,
        strike: inst.strike,
        optionType: inst.optionType,
      },
    };

    this.signalEmittedFor[direction] = true;
    this.signalsToday++;
    log.info("Engine B signal", {
      direction,
      strike: inst.strike,
      type: inst.optionType,
      contracts,
      limitPrice,
    });
    this.signalHandler?.(signal);
  }

  // 5-min volume-weighted average (volume from ticks not available via this
  // path; approximate with simple typical-price average across the last
  // ~12 bars). When we add real volume from the stream, swap to weighted.
  private computeVwap(): number {
    const bars = this.currentBar ? [...this.bars, this.currentBar] : this.bars;
    if (bars.length === 0) return NaN;
    let sum = 0;
    for (const b of bars) {
      sum += (b.high + b.low + b.close) / 3;
    }
    return sum / bars.length;
  }
}

function roundOptionTick(price: number): number {
  // Below $3.00, options tick at $0.01. Above $3.00, $0.05.
  if (price < 3) return Math.round(price * 100) / 100;
  return Math.round(price * 20) / 20;
}
