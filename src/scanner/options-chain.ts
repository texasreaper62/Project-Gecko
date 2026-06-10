// Option chain monitor for 0DTE SPY (used by Engine B).
//
// Schwab returns the chain organized as callExpDateMap / putExpDateMap,
// each keyed by "YYYY-MM-DD:DTE" and then by strike string. We flatten
// to a list of contracts for an expiration date and pick the ATM strike
// based on the underlying's last price.

import { createLogger } from "../core/logger.js";
import { etDate } from "../utils/time.js";
import { isBroker, type Broker, type NormalizedOptionContract } from "../brokers/broker.js";
import type { OptionInstrument } from "../core/types.js";
import type { SchwabRest } from "../brokers/schwab/rest.js";
import type { SchwabOptionContract } from "../brokers/schwab/types.js";

const log = createLogger("options-chain");

export interface AtmPair {
  readonly underlyingPrice: number;
  readonly expiration: string;          // YYYY-MM-DD
  readonly call: AtmContract;
  readonly put: AtmContract;
}

export interface AtmContract {
  readonly instrument: OptionInstrument;
  readonly mid: number;
  readonly bid: number;
  readonly ask: number;
  readonly delta: number;
  readonly gamma: number;
  readonly theta: number;
  readonly iv: number;
  readonly openInterest: number;
  readonly volume: number;
}

export class OptionsChainMonitor {
  // Chain source is SchwabRest when BROKER=schwab (full chain in one call)
  // or any Broker adapter otherwise (normalized ATM ring).
  constructor(private readonly source: SchwabRest | Broker) {}

  // Fetch today's 0DTE pair for the underlying. If no 0DTE expiration exists
  // (e.g. SPY only lists Mon/Wed/Fri 0DTEs historically; weeklies expanded
  // in 2022; daily for SPY is now universal), returns null.
  async getZeroDtePair(underlyingSymbol: string): Promise<AtmPair | null> {
    const today = etDate();
    if (isBroker(this.source)) {
      return this.getZeroDtePairViaBroker(this.source, underlyingSymbol, today);
    }
    const rest = this.source;
    const chain = await rest.getOptionChain({
      symbol: underlyingSymbol,
      contractType: "ALL",
      strikeCount: 20,
      includeUnderlyingQuote: true,
      strategy: "SINGLE",
      fromDate: today,
      toDate: today,
    });

    const underlyingPrice = chain.underlying?.last
      ?? chain.underlying?.bid
      ?? 0;
    if (underlyingPrice <= 0) {
      log.warn("0DTE chain: no underlying price", { symbol: underlyingSymbol });
      return null;
    }

    const callKey = this.findExpirationKey(chain.callExpDateMap, today);
    const putKey = this.findExpirationKey(chain.putExpDateMap, today);
    if (!callKey || !putKey) {
      log.info("No 0DTE expiration available", { symbol: underlyingSymbol, today });
      return null;
    }

    const calls = this.flatten(chain.callExpDateMap[callKey]);
    const puts = this.flatten(chain.putExpDateMap[putKey]);
    if (calls.length === 0 || puts.length === 0) return null;

    const atmCall = nearestStrike(calls, underlyingPrice);
    const atmPut = nearestStrike(puts, underlyingPrice);
    if (!atmCall || !atmPut) return null;

    return {
      underlyingPrice,
      expiration: today,
      call: this.toAtmContract(underlyingSymbol, atmCall, "CALL"),
      put: this.toAtmContract(underlyingSymbol, atmPut, "PUT"),
    };
  }

  // Broker-interface path (IBKR). The adapter returns an ATM ring of
  // normalized contracts for the requested window; filter to contracts that
  // expire today and pick the nearest strike on each side.
  private async getZeroDtePairViaBroker(
    broker: Broker,
    underlyingSymbol: string,
    today: string,
  ): Promise<AtmPair | null> {
    const chain = await broker.getOptionChain({
      underlying: underlyingSymbol,
      fromDate: today,
      toDate: today,
      contractType: "BOTH",
    });
    if (!chain || chain.underlyingPrice <= 0) {
      log.warn("0DTE chain: no chain or underlying price", { symbol: underlyingSymbol });
      return null;
    }

    const calls = chain.calls.filter((c) => c.instrument.expiration === today);
    const puts = chain.puts.filter((c) => c.instrument.expiration === today);
    if (calls.length === 0 || puts.length === 0) {
      log.info("No 0DTE expiration available", { symbol: underlyingSymbol, today });
      return null;
    }

    const atmCall = nearestNormalized(calls, chain.underlyingPrice);
    const atmPut = nearestNormalized(puts, chain.underlyingPrice);
    if (!atmCall || !atmPut) return null;

    return {
      underlyingPrice: chain.underlyingPrice,
      expiration: today,
      call: normalizedToAtm(atmCall),
      put: normalizedToAtm(atmPut),
    };
  }

  // Find expiration key matching today's date. Schwab keys look like
  // "2026-05-21:0" (date:DTE).
  private findExpirationKey(map: Record<string, unknown>, today: string): string | null {
    for (const key of Object.keys(map)) {
      if (key.startsWith(today)) return key;
    }
    return null;
  }

  private flatten(strikes: Record<string, readonly SchwabOptionContract[]>): SchwabOptionContract[] {
    const out: SchwabOptionContract[] = [];
    for (const arr of Object.values(strikes)) {
      for (const c of arr) out.push(c);
    }
    return out;
  }

  private toAtmContract(
    underlying: string,
    c: SchwabOptionContract,
    optionType: "CALL" | "PUT",
  ): AtmContract {
    const mid = c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : (c.mark ?? c.last);
    return {
      instrument: {
        assetClass: "option",
        underlying,
        expiration: c.expirationDate.slice(0, 10),
        strike: c.strikePrice,
        optionType,
        osiSymbol: c.symbol,
      },
      mid,
      bid: c.bid,
      ask: c.ask,
      delta: c.delta,
      gamma: c.gamma,
      theta: c.theta,
      iv: c.volatility,
      openInterest: c.openInterest,
      volume: c.totalVolume,
    };
  }
}

function nearestNormalized(
  contracts: readonly NormalizedOptionContract[],
  underlying: number,
): NormalizedOptionContract | null {
  let best: NormalizedOptionContract | null = null;
  let bestDist = Infinity;
  for (const c of contracts) {
    if (!Number.isFinite(c.instrument.strike)) continue;
    const d = Math.abs(c.instrument.strike - underlying);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function normalizedToAtm(c: NormalizedOptionContract): AtmContract {
  return {
    instrument: c.instrument,
    mid: c.mid,
    bid: c.bid,
    ask: c.ask,
    delta: c.delta ?? 0,
    gamma: c.gamma ?? 0,
    theta: c.theta ?? 0,
    iv: c.iv ?? 0,
    openInterest: c.openInterest ?? 0,
    volume: c.volume ?? 0,
  };
}

function nearestStrike(
  contracts: readonly SchwabOptionContract[],
  underlying: number,
): SchwabOptionContract | null {
  let best: SchwabOptionContract | null = null;
  let bestDist = Infinity;
  for (const c of contracts) {
    if (!Number.isFinite(c.strikePrice)) continue;
    const d = Math.abs(c.strikePrice - underlying);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}
