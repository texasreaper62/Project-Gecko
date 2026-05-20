// Position sizing: fixed-fractional risk per trade.
//
// Equity sizing:
//   risk_dollars = account_equity * MAX_RISK_PER_TRADE_PCT / 100
//   shares       = floor(risk_dollars / stop_distance_per_share)
//
// Option sizing:
//   Contracts are sized off premium paid, not stop distance, because the
//   option's premium IS the maximum loss (for long calls/puts).
//   max_loss_per_contract = (premium * 100) since equity options multiplier = 100
//   contracts = floor(risk_dollars / max_loss_per_contract)
//
// All sizes are then clamped against buying-power constraints in the
// risk-manager, not here.

export interface SizeEquityArgs {
  readonly accountEquity: number;
  readonly riskPerTradePct: number;     // e.g. 1.0 for 1%
  readonly entryPrice: number;
  readonly stopPrice: number;
}

export interface SizeOptionArgs {
  readonly accountEquity: number;
  readonly riskPerTradePct: number;     // e.g. 1.0 for 1%
  readonly premiumPerContract: number;  // option mid or ask, dollars per share
  readonly maxRiskFractionOfPremium?: number;  // default 0.5 (assume hit -50% stop)
  readonly contractMultiplier?: number;        // default 100
}

export function sizeEquityPosition(args: SizeEquityArgs): {
  readonly shares: number;
  readonly riskUsd: number;
  readonly stopDistance: number;
} {
  if (!Number.isFinite(args.entryPrice) || args.entryPrice <= 0) {
    return { shares: 0, riskUsd: 0, stopDistance: 0 };
  }
  if (!Number.isFinite(args.stopPrice) || args.stopPrice <= 0) {
    return { shares: 0, riskUsd: 0, stopDistance: 0 };
  }
  if (args.stopPrice === args.entryPrice) {
    return { shares: 0, riskUsd: 0, stopDistance: 0 };
  }
  if (args.accountEquity <= 0 || args.riskPerTradePct <= 0) {
    return { shares: 0, riskUsd: 0, stopDistance: 0 };
  }

  const riskUsd = args.accountEquity * args.riskPerTradePct / 100;
  const stopDistance = Math.abs(args.entryPrice - args.stopPrice);
  const shares = Math.floor(riskUsd / stopDistance);

  return { shares, riskUsd, stopDistance };
}

export function sizeOptionPosition(args: SizeOptionArgs): {
  readonly contracts: number;
  readonly riskUsd: number;
  readonly costUsd: number;
} {
  const mult = args.contractMultiplier ?? 100;
  const stopFrac = args.maxRiskFractionOfPremium ?? 0.5;

  if (!Number.isFinite(args.premiumPerContract) || args.premiumPerContract <= 0) {
    return { contracts: 0, riskUsd: 0, costUsd: 0 };
  }
  if (args.accountEquity <= 0 || args.riskPerTradePct <= 0) {
    return { contracts: 0, riskUsd: 0, costUsd: 0 };
  }

  const riskUsd = args.accountEquity * args.riskPerTradePct / 100;
  const maxLossPerContract = args.premiumPerContract * mult * stopFrac;
  const contracts = Math.floor(riskUsd / maxLossPerContract);
  const costUsd = contracts * args.premiumPerContract * mult;

  return { contracts, riskUsd, costUsd };
}
