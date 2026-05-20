// CLI: run the ORB backtester against a symbol list and date range.
//
// Usage:
//   npm run backtest -- --symbols=PLTR,SOFI,GME --start=2025-11-01 --end=2026-04-30
//   npm run backtest -- --watchlist --start=2025-11-01 --end=2026-04-30
//   npm run backtest -- --watchlist --start=2025-11-01 --end=2026-04-30 --equity=5000

import { loadConfig } from "../core/config.js";
import { createLogger, setLogLevel } from "../core/logger.js";
import { SchwabAuth } from "../brokers/schwab/auth.js";
import { SchwabRest } from "../brokers/schwab/rest.js";
import { HistoricalBars } from "../data/historical.js";
import { PremarketScanner } from "../scanner/premarket.js";
import { OrbBacktester } from "./runner.js";
import { computeMetrics, formatMetricsReport } from "./metrics.js";

const log = createLogger("backtest-cli");

interface Args {
  symbols: string[];
  start: string;
  end: string;
  equity: number;
}

function parseArgs(): Args {
  const out: Args = { symbols: [], start: "", end: "", equity: 5000 };
  let useWatchlist = false;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--symbols=")) {
      out.symbols = a.slice("--symbols=".length).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    } else if (a.startsWith("--start=")) {
      out.start = a.slice("--start=".length);
    } else if (a.startsWith("--end=")) {
      out.end = a.slice("--end=".length);
    } else if (a.startsWith("--equity=")) {
      out.equity = Number(a.slice("--equity=".length));
    } else if (a === "--watchlist") {
      useWatchlist = true;
    }
  }
  if (!out.start || !out.end) {
    process.stderr.write("Usage: --start=YYYY-MM-DD --end=YYYY-MM-DD --symbols=AAA,BBB | --watchlist [--equity=5000]\n");
    process.exit(1);
  }
  if (useWatchlist && out.symbols.length === 0) {
    // Defer to scanner's loadWatchlist at runtime.
    out.symbols = [];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const auth = new SchwabAuth({
    clientId: config.schwabClientId,
    clientSecret: config.schwabClientSecret,
    redirectUri: config.schwabRedirectUri,
  });
  const loaded = await auth.load();
  if (!loaded) {
    process.stderr.write("FATAL: No persisted tokens. Run `npm run auth` first.\n");
    process.exit(1);
  }
  auth.startAutoRefresh();

  const rest = new SchwabRest(auth);
  const historical = new HistoricalBars(rest);

  let symbols = args.symbols;
  if (symbols.length === 0) {
    const scanner = new PremarketScanner(config, rest, historical);
    symbols = [...scanner.loadWatchlist()];
    log.info("Loaded watchlist for backtest", { count: symbols.length });
  }

  const backtester = new OrbBacktester(config, historical);
  const trades = await backtester.run({
    symbols,
    startDate: args.start,
    endDate: args.end,
    startingEquity: args.equity,
  });

  const metrics = computeMetrics(trades, args.equity);
  process.stdout.write("\n===== Backtest Report =====\n");
  process.stdout.write(`Symbols:         ${symbols.length}\n`);
  process.stdout.write(`Date range:      ${args.start} to ${args.end}\n`);
  process.stdout.write(`Starting equity: $${args.equity}\n\n`);
  process.stdout.write(formatMetricsReport(metrics) + "\n");
  process.stdout.write("===========================\n");

  auth.stopAutoRefresh();
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
