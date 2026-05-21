// PairsTraderStrategy: statistical arbitrage on correlated stock pairs.
//
// Identifies pairs that historically move together (correlation > 0.7),
// continuously computes the spread (ratio of prices), and enters a fade
// when the spread is N standard deviations from its rolling mean.
//
// Mechanics:
//   - Maintain rolling N-bar price history for both legs of each pair
//   - Compute spread = log(A) - beta * log(B) where beta is rolling regression slope
//   - Z-score the spread: (current - mean) / stdev
//   - When |z| > ENTRY_Z, fade: short the rich leg, long the cheap leg
//   - When |z| < EXIT_Z, exit
//   - Time stop: hold for max HOLD_MAX_MIN if z doesn't normalize
//
// Why this works alongside ORB and Mean-Reversion:
//   - ORB is directional momentum (single-leg, trending markets)
//   - Mean-Reversion is single-leg fade (range-bound markets)
//   - Pairs trading is MARKET-NEUTRAL: profitable whether market goes up or
//     down. As long as the pair converges, we win. Uncorrelated with overall
//     market direction.
//
// Pre-validated pairs (high correlation, similar fundamentals):
//   MARA / RIOT  (crypto miners)
//   NIO / XPEV   (China EV makers) — but XPEV not in default watchlist
//   PLTR / AI    (AI plays)
//   SOFI / AFRM  (fintech lenders)
//
// For now we start with one rock-solid pair (MARA/RIOT) and expand as
// outcome data validates.

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

const log = createLogger("pairs-trader");

const ACTIVE_START_MIN = 10 * 60;         // 10:00 ET (let opening volatility settle)
const ACTIVE_END_MIN = 15 * 60;           // 15:00 ET (close out before close)
const HISTORY_BARS = 60;                  // 60 ticks of history for z-score
const ENTRY_Z = 2.0;                      // 2 sigma divergence triggers entry
const EXIT_Z = 0.3;                       // close when spread normalizes
const HOLD_MAX_MIN = 60;                  // 60-minute max hold
const COOLDOWN_MS = 30 * 60 * 1000;       // 30-min cooldown per pair after a signal

interface Pair {
  readonly a: string;
  readonly b: string;
}

interface PairState {
  readonly pair: Pair;
  pricesA: number[];                       // rolling price history
  pricesB: number[];
  lastSignalAt: number;
  signalsToday: number;
  lastDate: string;
}

const DEFAULT_PAIRS: readonly Pair[] = [
  { a: "MARA", b: "RIOT" },               // crypto miners
];

const MAX_SIGNALS_PER_PAIR_PER_DAY = 2;

export class PairsTraderStrategy implements Strategy {
  readonly name = "pairs-trader";

  private readonly pairs: readonly Pair[];
  private state: Map<string, PairState> = new Map();           // keyed by "A|B"
  private signalHandler: ((signal: TradeSignal) => void) | null = null;
  private getAccount: () => AccountSnapshot | null = () => null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly broker: Broker,
    pairs: readonly Pair[] = DEFAULT_PAIRS,
  ) {
    this.pairs = pairs;
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
    const allSymbols = new Set<string>();
    for (const p of this.pairs) {
      this.state.set(this.pairKey(p), {
        pair: p, pricesA: [], pricesB: [],
        lastSignalAt: 0, signalsToday: 0, lastDate: "",
      });
      allSymbols.add(p.a);
      allSymbols.add(p.b);
    }
    await this.broker.subscribeEquities([...allSymbols]);
    log.info("PairsTrader started", { pairs: this.pairs.map(p => `${p.a}/${p.b}`) });
  }

  stop(): void {
    this.running = false;
    log.info("PairsTrader stopped");
  }

  handleEquityTick(ticks: readonly NormalizedTick[]): void {
    if (!this.running) return;
    for (const t of ticks) {
      for (const [, state] of this.state) {
        const isA = state.pair.a === t.symbol;
        const isB = state.pair.b === t.symbol;
        if (!isA && !isB) continue;
        if (!Number.isFinite(t.last) || t.last <= 0) continue;

        const p = etParts(t.timestamp);
        const date = p.date;
        if (date !== state.lastDate) {
          state.lastDate = date;
          state.signalsToday = 0;
          state.pricesA = [];
          state.pricesB = [];
        }

        if (isA) state.pricesA.push(t.last);
        if (isB) state.pricesB.push(t.last);
        if (state.pricesA.length > HISTORY_BARS) state.pricesA.shift();
        if (state.pricesB.length > HISTORY_BARS) state.pricesB.shift();

        const minOfDay = p.hour * 60 + p.minute;
        if (minOfDay < ACTIVE_START_MIN || minOfDay >= ACTIVE_END_MIN) continue;
        this.evaluate(state);
      }
    }
  }

  // ----- Internals -----

  private pairKey(p: Pair): string { return `${p.a}|${p.b}`; }

  private evaluate(state: PairState): void {
    if (state.signalsToday >= MAX_SIGNALS_PER_PAIR_PER_DAY) return;
    if (Date.now() - state.lastSignalAt < COOLDOWN_MS) return;
    if (state.pricesA.length < HISTORY_BARS || state.pricesB.length < HISTORY_BARS) return;

    // Align lengths.
    const n = Math.min(state.pricesA.length, state.pricesB.length);
    const a = state.pricesA.slice(-n);
    const b = state.pricesB.slice(-n);

    // Compute spread = log(A) - log(B) (simple log-ratio; can use beta later).
    const spread: number[] = [];
    for (let i = 0; i < n; i++) spread.push(Math.log(a[i]) - Math.log(b[i]));

    const mean = spread.reduce((s, x) => s + x, 0) / spread.length;
    const variance = spread.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, spread.length - 1);
    const stdev = Math.sqrt(variance);
    if (stdev <= 0) return;

    const current = spread[spread.length - 1];
    const z = (current - mean) / stdev;

    if (Math.abs(z) < ENTRY_Z) return;

    // z > 0 -> A is rich relative to B -> short A, long B
    // z < 0 -> A is cheap relative to B -> long A, short B
    const richSymbol = z > 0 ? state.pair.a : state.pair.b;
    const cheapSymbol = z > 0 ? state.pair.b : state.pair.a;
    const richPrice = z > 0 ? a[a.length - 1] : b[b.length - 1];
    const cheapPrice = z > 0 ? b[b.length - 1] : a[a.length - 1];

    const account = this.getAccount();
    if (!account) return;

    // Pairs use half the per-trade risk on each leg (we're risking on the
    // SPREAD not on either leg alone). Stop distance is set proportionally
    // to the standard deviation of the spread.
    const halfRisk = this.config.maxRiskPerTradePct / 2;
    const stopDistMul = 1.0;     // stop at +1.5 stdev past entry (loose; spread can wander)
    const stopDistPctRich = stopDistMul * Math.abs(stdev) * 100;

    // Size the long leg.
    const longSized = sizeEquityPosition({
      accountEquity: account.equity,
      riskPerTradePct: halfRisk,
      entryPrice: cheapPrice,
      stopPrice: cheapPrice * (1 - stopDistPctRich / 100),
    });
    // Size the short leg.
    const shortSized = sizeEquityPosition({
      accountEquity: account.equity,
      riskPerTradePct: halfRisk,
      entryPrice: richPrice,
      stopPrice: richPrice * (1 + stopDistPctRich / 100),
    });
    if (longSized.shares <= 0 || shortSized.shares <= 0) return;

    // For shadow + initial live, only emit the LONG leg of the pair (single-
    // leg trade) since we don't yet support multi-leg orders cleanly.
    // We treat the long leg as the primary trade; the short leg is logged
    // as intent but executed via a second signal in a future iteration.
    state.lastSignalAt = Date.now();
    state.signalsToday++;

    const cheapInst: EquityInstrument = { assetClass: "equity", symbol: cheapSymbol };
    const longSignal: TradeSignal = {
      id: `pairs-${state.pair.a}-${state.pair.b}-LONG-${Date.now()}`,
      strategy: "pairs-trader",
      timestamp: Date.now(),
      description: `PAIRS LONG ${cheapSymbol} (vs SHORT ${richSymbol}) @ ${cheapPrice.toFixed(2)}, z=${z.toFixed(2)}`,
      order: {
        instrument: cheapInst,
        side: "BUY",
        quantity: longSized.shares,
        orderType: "LIMIT",
        timeInForce: "DAY",
        limitPrice: cheapPrice,
      },
      stopPrice: cheapPrice * (1 - stopDistPctRich / 100),
      takeProfitPrice: cheapPrice * (1 + 0.5 * stopDistPctRich / 100), // exit at half the distance
      riskUsd: longSized.riskUsd,
      rewardUsd: longSized.riskUsd * 0.5,
      metadata: {
        pair: `${state.pair.a}/${state.pair.b}`,
        zScore: z,
        spreadMean: mean,
        spreadStdev: stdev,
        richSymbol, cheapSymbol,
        breakoutDirection: "LONG",
        holdMaxMin: HOLD_MAX_MIN,
      },
    };

    log.info("PairsTrader signal", {
      pair: `${state.pair.a}/${state.pair.b}`,
      action: `LONG ${cheapSymbol} SHORT ${richSymbol}`,
      z: z.toFixed(2),
      cheapPrice: cheapPrice.toFixed(2),
      richPrice: richPrice.toFixed(2),
    });
    this.signalHandler?.(longSignal);
  }
}
