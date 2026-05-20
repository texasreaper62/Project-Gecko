// Option chain monitor for 0DTE SPY (used by Engine B).
//
// Schwab returns the chain organized as callExpDateMap / putExpDateMap,
// each keyed by "YYYY-MM-DD:DTE" and then by strike string. We flatten
// to a list of contracts for an expiration date and pick the ATM strike
// based on the underlying's last price.

import { createLogger } from "../core/logger.js";
import { etDate } from "../utils/time.js";
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
  constructor(private readonly rest: SchwabRest) {}

  // Fetch today's 0DTE pair for the underlying. If no 0DTE expiration exists
  // (e.g. SPY only lists Mon/Wed/Fri 0DTEs historically; weeklies expanded
  // in 2022; daily for SPY is now universal), returns null.
  async getZeroDtePair(underlyingSymbol: string): Promise<AtmPair | null> {
    const today = etDate();
    const chain = await this.rest.getOptionChain({
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
