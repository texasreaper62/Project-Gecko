// Edge-case stress tests: validates the pipeline behaves correctly under
// scenarios that don't show up in a typical replay. Runs each test
// in-process against the broker abstraction with simulated data.
//
// Each test asserts an expected outcome. Failures are reported with
// context so we can fix the underlying logic.
//
// Usage: npm run stress

import { ShadowBroker } from "./shadow-broker.js";
import { ConfluenceEngine } from "../intelligence/confluence.js";
import { sizeEquityPosition, sizeOptionPosition } from "../risk/position-sizer.js";
import { RiskManager } from "../risk/risk-manager.js";
import { DailyStop } from "../risk/daily-stop.js";
import { PdtTracker } from "../risk/pdt-tracker.js";
import { PositionTracker } from "../execution/position-tracker.js";
import type { AppConfig, AccountSnapshot, TradeSignal, EquityInstrument } from "../core/types.js";

const config: AppConfig = {
  broker: "schwab",
  schwabClientId: "x", schwabClientSecret: "x", schwabRedirectUri: "", schwabAccountHash: "x",
  ibkrBaseUrl: "",
  anthropicApiKey: "", llmEnabled: false, llmModel: "claude-sonnet-4-6",
  agentBrainEnabled: false, agentBrainMinConviction: 70,
  liveTrading: false, killSwitch: false,
  maxRiskPerTradePct: 1.0,
  maxConcurrentEquityPositions: 3, maxConcurrentOptionPositions: 2,
  dailyLossLimitPct: 3, maxDayTrades: 4,
  orbEnabled: true, orbMinGapPct: 2, orbMinPremarketVolume: 100_000, orbMinPrice: 5, orbMaxPrice: 50,
  dte0Enabled: true, dte0MaxContractsPerTrade: 1, dte0MaxTradesPerDay: 2,
  telegramBotToken: "", telegramChatId: "", discordWebhookUrl: "",
  logLevel: "info",
};

interface TestResult { name: string; passed: boolean; detail: string; }
const results: TestResult[] = [];

function assert(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  process.stdout.write(`${passed ? "PASS" : "FAIL"}  ${name}\n`);
  if (!passed) process.stdout.write(`        ${detail}\n`);
}

// ----- Position sizer -----

function testSizing(): void {
  // Equity sizing: $5000 account, 1% risk, entry $100, stop $98 -> $2 stop dist
  // -> $50 risk / $2 = 25 shares
  const eq = sizeEquityPosition({ accountEquity: 5000, riskPerTradePct: 1, entryPrice: 100, stopPrice: 98 });
  assert("equity sizing math", eq.shares === 25, `expected 25 shares, got ${eq.shares}`);

  // Stop = entry should produce 0 shares (avoid div-by-zero blowup)
  const zero = sizeEquityPosition({ accountEquity: 5000, riskPerTradePct: 1, entryPrice: 100, stopPrice: 100 });
  assert("zero stop-distance returns 0", zero.shares === 0, `expected 0, got ${zero.shares}`);

  // Negative inputs produce 0
  const neg = sizeEquityPosition({ accountEquity: 5000, riskPerTradePct: 1, entryPrice: -1, stopPrice: 98 });
  assert("negative entry returns 0", neg.shares === 0, `expected 0, got ${neg.shares}`);

  // Option sizing: $5000, 1% risk, $2 premium -> $50 risk / ($2 * 100 * 0.5) = 0.5 -> floor to 0
  const opt = sizeOptionPosition({ accountEquity: 5000, riskPerTradePct: 1, premiumPerContract: 2 });
  assert("option sizing tiny account", opt.contracts === 0, `expected 0 contracts at $5k, got ${opt.contracts}`);

  // Bigger account: $20000, $1 premium -> $200 risk / ($1 * 100 * 0.5) = 4
  const opt2 = sizeOptionPosition({ accountEquity: 20_000, riskPerTradePct: 1, premiumPerContract: 1 });
  assert("option sizing 20k account", opt2.contracts === 4, `expected 4 contracts, got ${opt2.contracts}`);
}

// ----- Daily stop -----

function testDailyStop(): void {
  const ds = new DailyStop(3);                        // 3% halt
  ds.resetForDay("2026-05-21", 5000);

  ds.update(5000);
  assert("daily stop not tripped at 0% drawdown", !ds.isHalted(), "should be active");

  ds.update(4900);
  assert("daily stop not tripped at -2% drawdown", !ds.isHalted(), "should be active (-2% < -3%)");

  ds.update(4849);                                     // -3.02% drawdown
  assert("daily stop trips at -3% drawdown", ds.isHalted(), "should be halted");

  // After tripping, should stay halted even if equity recovers
  ds.update(5100);
  assert("daily stop stays tripped after recovery", ds.isHalted(), "should stay halted");
}

// ----- Risk manager -----

function testRiskManager(): void {
  const ds = new DailyStop(3);
  ds.resetForDay("2026-05-21", 5000);
  const pdt = new PdtTracker(4);
  const positions = new PositionTracker();
  const rm = new RiskManager({ ...config, liveTrading: true }, ds, pdt, positions);

  const acct: AccountSnapshot = {
    cashBalance: 5000, buyingPower: 20_000, dayTradeBuyingPower: 20_000,
    equity: 5000, dayTradeCount: 0, timestamp: Date.now(),
  };
  const inst: EquityInstrument = { assetClass: "equity", symbol: "PLTR" };
  const goodSignal: TradeSignal = {
    id: "test-1", strategy: "orb", timestamp: Date.now(),
    description: "test",
    order: { instrument: inst, side: "BUY", quantity: 10, orderType: "LIMIT", timeInForce: "DAY", limitPrice: 100 },
    stopPrice: 98, takeProfitPrice: 104, riskUsd: 20, rewardUsd: 40, metadata: {},
  };
  assert("good signal passes risk", rm.check(goodSignal, acct).allowed, "should pass");

  // Kill switch active -> deny
  rm.activateKillSwitch("test");
  assert("kill switch blocks trade", !rm.check(goodSignal, acct).allowed, "should be denied");
  rm.deactivateKillSwitch();

  // Notional > BP -> deny
  const bigSignal: TradeSignal = {
    ...goodSignal, id: "test-2",
    order: { ...goodSignal.order, quantity: 10_000 },
  };
  assert("notional exceeds BP blocks", !rm.check(bigSignal, acct).allowed, "should be denied");

  // Daily stop tripped -> deny
  ds.update(4800);                          // 4% drawdown
  assert("daily stop blocks trade", !rm.check(goodSignal, acct).allowed, "should be denied (daily stop)");
}

// ----- Confluence engine -----

function testConfluence(): void {
  const eng = new ConfluenceEngine({ minSignals: 3, minScore: 0.5, requireUnanimity: true });

  // 3 strong positive signals -> pass
  const passResult = eng.evaluate("sig-1", "LONG", [
    { name: "strategy-trigger", vote: 1, confidence: 0.7, weight: 1.0 },
    { name: "tf", vote: 0.8, confidence: 0.8, weight: 1.0 },
    { name: "internals", vote: 0.7, confidence: 0.7, weight: 1.0 },
  ]);
  assert("confluence passes with 3 strong supports", passResult.passed, passResult.reasoning);

  // 1 opposing vote with unanimity required -> fail
  const opposingResult = eng.evaluate("sig-2", "LONG", [
    { name: "strategy-trigger", vote: 1, confidence: 0.7, weight: 1.0 },
    { name: "tf", vote: 0.8, confidence: 0.8, weight: 1.0 },
    { name: "internals", vote: -0.8, confidence: 0.7, weight: 1.0 },
  ]);
  assert("confluence rejects on opposition (unanimity mode)", !opposingResult.passed, opposingResult.reasoning);

  // Not enough signals -> fail
  const fewResult = eng.evaluate("sig-3", "LONG", [
    { name: "strategy-trigger", vote: 1, confidence: 0.7, weight: 1.0 },
    { name: "tf", vote: 0, confidence: 0, weight: 1.0 },          // no data
    { name: "internals", vote: 0, confidence: 0, weight: 1.0 },   // no data
  ]);
  assert("confluence rejects with too few non-neutral", !fewResult.passed, fewResult.reasoning);
}

// ----- Shadow broker math -----

async function testShadowBroker(): Promise<void> {
  const b = new ShadowBroker({ startingEquity: 5000 });
  await b.start();
  b.setStreamHandler(() => {});
  await b.subscribeEquities(["PLTR"]);
  b.emitTick("equity-tick", [{ symbol: "PLTR", last: 100, timestamp: Date.now() }]);

  // BUY 10 PLTR @ 100 -> cash decreases by $1000
  const buy = await b.placeOrder({
    instrument: { assetClass: "equity", symbol: "PLTR" },
    side: "BUY", quantity: 10, orderType: "LIMIT", limitPrice: 100, tif: "DAY",
  });
  const snap = await b.getAccountSnapshot();
  assert("shadow BUY debits cash", snap.cashBalance === 4000, `expected 4000, got ${snap.cashBalance}`);

  // Status should be FILLED
  const status = await b.getOrderStatus(buy.orderId);
  assert("shadow order reports FILLED", status?.status === "FILLED", `got ${status?.status}`);

  // SELL 10 PLTR @ 105 -> cash + 1050
  const sell = await b.placeOrder({
    instrument: { assetClass: "equity", symbol: "PLTR" },
    side: "SELL", quantity: 10, orderType: "LIMIT", limitPrice: 105, tif: "DAY",
  });
  const snap2 = await b.getAccountSnapshot();
  assert("shadow SELL credits cash", snap2.cashBalance === 5050, `expected 5050, got ${snap2.cashBalance}`);
  assert("shadow sell order id distinct", sell.orderId !== buy.orderId, "ids should differ");
}

// ----- Position tracker open/close cycle -----

function testPositionTracker(): void {
  const pt = new PositionTracker();
  const inst: EquityInstrument = { assetClass: "equity", symbol: "PLTR" };

  pt.open({ instrument: inst, side: "LONG", entryPrice: 100, quantity: 10, strategy: "orb", metadata: {} });
  assert("position open registers", pt.hasInstrument(inst), "should have position");
  assert("position count by class", pt.countByAssetClass("equity") === 1, `got ${pt.countByAssetClass("equity")}`);

  pt.updatePrice(inst, 105);
  const pos = pt.get(inst);
  assert("unrealized P&L on long", pos!.unrealizedPnl === 50, `expected 50, got ${pos!.unrealizedPnl}`);

  const closed = pt.close(inst, 105, 0);
  assert("close returns pnl", closed?.pnl === 50, `expected 50, got ${closed?.pnl}`);
  assert("close removes position", !pt.hasInstrument(inst), "should be removed");
}

// ----- Run all -----

async function main(): Promise<void> {
  process.stdout.write("\n===== Stress tests =====\n\n");

  testSizing();
  testDailyStop();
  testRiskManager();
  testConfluence();
  await testShadowBroker();
  testPositionTracker();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  process.stdout.write(`\n===== ${passed}/${results.length} passed =====\n`);
  if (failed > 0) {
    process.stderr.write(`\n${failed} test(s) failed.\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
