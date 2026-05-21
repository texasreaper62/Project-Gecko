// Backtest metrics: Sharpe, max drawdown, R-multiple distribution, win rate.

export interface BacktestTrade {
  readonly date: string;            // YYYY-MM-DD
  readonly symbol: string;
  readonly direction: "LONG" | "SHORT";
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly stop: number;
  readonly take: number;
  readonly shares: number;
  readonly pnl: number;
  readonly rMultiple: number;
  readonly exitReason: "take" | "stop" | "time" | "eod";
  readonly entryTime: number;
  readonly exitTime: number;
}

export interface BacktestMetrics {
  readonly trades: number;
  readonly winners: number;
  readonly losers: number;
  readonly winRate: number;
  readonly totalPnl: number;
  readonly avgWin: number;
  readonly avgLoss: number;
  readonly profitFactor: number;
  readonly avgR: number;
  readonly sharpe: number;
  readonly maxDrawdown: number;
  readonly maxDrawdownPct: number;
  readonly equityCurve: readonly number[];
}

export function computeMetrics(
  trades: readonly BacktestTrade[],
  startingEquity: number,
): BacktestMetrics {
  if (trades.length === 0) {
    return {
      trades: 0,
      winners: 0,
      losers: 0,
      winRate: 0,
      totalPnl: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      avgR: 0,
      sharpe: 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      equityCurve: [startingEquity],
    };
  }

  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl <= 0);
  const totalWin = winners.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const totalPnl = totalWin - totalLoss;

  // Equity curve
  const curve: number[] = [startingEquity];
  for (const t of trades) {
    curve.push(curve[curve.length - 1] + t.pnl);
  }

  // Max drawdown
  let peak = curve[0];
  let maxDd = 0;
  let maxDdPct = 0;
  for (const e of curve) {
    if (e > peak) peak = e;
    const dd = peak - e;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = peak > 0 ? (dd / peak) * 100 : 0;
    }
  }

  // Sharpe: per-trade return / std of per-trade return * sqrt(N).
  const returns = trades.map((t) => t.pnl / startingEquity);
  const meanRet = returns.reduce((s, r) => s + r, 0) / returns.length;
  const varRet = returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / Math.max(1, returns.length - 1);
  const stdRet = Math.sqrt(varRet);
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(252) : 0;

  return {
    trades: trades.length,
    winners: winners.length,
    losers: losers.length,
    winRate: winners.length / trades.length,
    totalPnl,
    avgWin: winners.length > 0 ? totalWin / winners.length : 0,
    avgLoss: losers.length > 0 ? -(totalLoss / losers.length) : 0,
    profitFactor: totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? Infinity : 0),
    avgR: trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length,
    sharpe,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    equityCurve: curve,
  };
}

export function formatMetricsReport(m: BacktestMetrics): string {
  return [
    `Trades:          ${m.trades} (${m.winners}W / ${m.losers}L)`,
    `Win rate:        ${(m.winRate * 100).toFixed(1)}%`,
    `Total P&L:       $${m.totalPnl.toFixed(2)}`,
    `Avg win:         $${m.avgWin.toFixed(2)}`,
    `Avg loss:        $${m.avgLoss.toFixed(2)}`,
    `Profit factor:   ${m.profitFactor === Infinity ? "inf" : m.profitFactor.toFixed(2)}`,
    `Avg R:           ${m.avgR.toFixed(2)}`,
    `Sharpe (ann.):   ${m.sharpe.toFixed(2)}`,
    `Max drawdown:    $${m.maxDrawdown.toFixed(2)} (${m.maxDrawdownPct.toFixed(1)}%)`,
  ].join("\n");
}
