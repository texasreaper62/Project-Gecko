// Build Schwab order payloads from typed strategy signals.
//
// Equities: single-leg, NORMAL session, DAY duration. LIMIT preferred.
// Options:  single-leg, NORMAL session, DAY duration. LIMIT (never market
//           on options -- spreads can be wide and a market order will pay
//           through the book.)
//
// We keep this layer dumb. Sizing and risk live elsewhere. Here we only
// translate the shape.

import type {
  EquityInstrument,
  OptionInstrument,
  OrderRequest,
  OrderSide,
} from "../core/types.js";
import type {
  SchwabInstruction,
  SchwabOrderRequest,
} from "../brokers/schwab/types.js";

export function buildEquityOrder(req: OrderRequest): SchwabOrderRequest {
  if (req.instrument.assetClass !== "equity") {
    throw new Error("buildEquityOrder called with non-equity instrument");
  }
  if (req.orderType === "MARKET") {
    return buildEquityMarketOrder(req.instrument, req.side, req.quantity);
  }
  if (req.orderType === "LIMIT") {
    if (req.limitPrice === undefined) {
      throw new Error("LIMIT order requires limitPrice");
    }
    return buildEquityLimitOrder(req.instrument, req.side, req.quantity, req.limitPrice);
  }
  if (req.orderType === "STOP") {
    if (req.stopPrice === undefined) {
      throw new Error("STOP order requires stopPrice");
    }
    return buildEquityStopOrder(req.instrument, req.side, req.quantity, req.stopPrice);
  }
  if (req.orderType === "STOP_LIMIT") {
    if (req.stopPrice === undefined || req.limitPrice === undefined) {
      throw new Error("STOP_LIMIT order requires both stopPrice and limitPrice");
    }
    return buildEquityStopLimitOrder(
      req.instrument,
      req.side,
      req.quantity,
      req.stopPrice,
      req.limitPrice,
    );
  }
  throw new Error(`Unsupported equity order type: ${req.orderType}`);
}

export function buildOptionOrder(req: OrderRequest): SchwabOrderRequest {
  if (req.instrument.assetClass !== "option") {
    throw new Error("buildOptionOrder called with non-option instrument");
  }
  // We do not place market orders on options. Caller must pass LIMIT.
  if (req.orderType !== "LIMIT") {
    throw new Error("Option orders must be LIMIT (market orders disabled by policy)");
  }
  if (req.limitPrice === undefined) {
    throw new Error("LIMIT option order requires limitPrice");
  }
  return buildOptionLimitOrder(req.instrument, req.side, req.quantity, req.limitPrice);
}

// ----- Equity builders -----

function buildEquityMarketOrder(
  inst: EquityInstrument,
  side: OrderSide,
  quantity: number,
): SchwabOrderRequest {
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: "MARKET",
    orderStrategyType: "SINGLE",
    orderLegCollection: [{
      instruction: equitySideToInstruction(side),
      quantity,
      instrument: { symbol: inst.symbol, assetType: "EQUITY" },
    }],
  };
}

function buildEquityLimitOrder(
  inst: EquityInstrument,
  side: OrderSide,
  quantity: number,
  limitPrice: number,
): SchwabOrderRequest {
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: "LIMIT",
    orderStrategyType: "SINGLE",
    price: round2(limitPrice),
    orderLegCollection: [{
      instruction: equitySideToInstruction(side),
      quantity,
      instrument: { symbol: inst.symbol, assetType: "EQUITY" },
    }],
  };
}

function buildEquityStopOrder(
  inst: EquityInstrument,
  side: OrderSide,
  quantity: number,
  stopPrice: number,
): SchwabOrderRequest {
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: "STOP",
    orderStrategyType: "SINGLE",
    stopPrice: round2(stopPrice),
    orderLegCollection: [{
      instruction: equitySideToInstruction(side),
      quantity,
      instrument: { symbol: inst.symbol, assetType: "EQUITY" },
    }],
  };
}

function buildEquityStopLimitOrder(
  inst: EquityInstrument,
  side: OrderSide,
  quantity: number,
  stopPrice: number,
  limitPrice: number,
): SchwabOrderRequest {
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: "STOP_LIMIT",
    orderStrategyType: "SINGLE",
    stopPrice: round2(stopPrice),
    price: round2(limitPrice),
    orderLegCollection: [{
      instruction: equitySideToInstruction(side),
      quantity,
      instrument: { symbol: inst.symbol, assetType: "EQUITY" },
    }],
  };
}

// ----- Option builder -----

function buildOptionLimitOrder(
  inst: OptionInstrument,
  side: OrderSide,
  quantity: number,
  limitPrice: number,
): SchwabOrderRequest {
  // Option premiums tick at $0.01 below $3 and $0.05 above (rough heuristic).
  // We round to $0.01 here; the caller is responsible for venue tick conformance.
  return {
    session: "NORMAL",
    duration: "DAY",
    orderType: "LIMIT",
    orderStrategyType: "SINGLE",
    price: round2(limitPrice),
    orderLegCollection: [{
      instruction: optionSideToInstruction(side),
      quantity,
      instrument: { symbol: inst.osiSymbol, assetType: "OPTION" },
    }],
  };
}

// ----- Side translation -----

function equitySideToInstruction(side: OrderSide): SchwabInstruction {
  switch (side) {
    case "BUY": return "BUY";
    case "SELL": return "SELL";
    default:
      throw new Error(`Unsupported equity side: ${side}`);
  }
}

function optionSideToInstruction(side: OrderSide): SchwabInstruction {
  switch (side) {
    case "BUY":
    case "BUY_TO_OPEN":
      return "BUY_TO_OPEN";
    case "SELL":
    case "SELL_TO_CLOSE":
      return "SELL_TO_CLOSE";
    case "BUY_TO_CLOSE":
      return "BUY_TO_CLOSE";
    case "SELL_TO_OPEN":
      return "SELL_TO_OPEN";
    default:
      throw new Error(`Unsupported option side: ${side}`);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
