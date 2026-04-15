/**
 * Core types for Project Gecko v2 -- Multi-Strategy Trading Agent
 *
 * Architecture: D0-inspired constrained autonomy
 * - Verified State: every fact carries freshness, provenance, authority
 * - Typed Boundary: model reasons in language, system executes typed actions
 * - Constraint Layer: verdicts issued outside model visibility
 * - Closed Loop: outcomes feed back as verified state
 */

// ============================================================
// VERIFIED STATE -- Facts with freshness/provenance/authority
// ============================================================

export type Freshness = 'live' | 'recent' | 'stale' | 'unknown';
export type Provenance = 'verified' | 'discovered' | 'untrusted';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface VerifiedFact<T> {
  readonly value: T;
  readonly timestamp: number;           // Unix ms when fact was obtained
  readonly freshness: Freshness;
  readonly provenance: Provenance;
  readonly source: string;              // "ibkr" | "edgar" | "nyse" | "calculated"
  readonly maxAgeMs: number;            // After this duration, freshness becomes 'stale'
}

export function createFact<T>(
  value: T,
  source: string,
  provenance: Provenance = 'verified',
  maxAgeMs: number = 60_000
): VerifiedFact<T> {
  return {
    value,
    timestamp: Date.now(),
    freshness: 'live',
    provenance,
    source,
    maxAgeMs,
  };
}

export function isFresh<T>(fact: VerifiedFact<T>): boolean {
  return (Date.now() - fact.timestamp) < fact.maxAgeMs;
}

export function getFreshness<T>(fact: VerifiedFact<T>): Freshness {
  const age = Date.now() - fact.timestamp;
  if (age < fact.maxAgeMs) return 'live';
  if (age < fact.maxAgeMs * 3) return 'recent';
  return 'stale';
}

// ============================================================
// ACCOUNT STATE
// ============================================================

export interface AccountState {
  readonly equity: VerifiedFact<number>;
  readonly buyingPower: VerifiedFact<number>;
  readonly openPositions: VerifiedFact<Position[]>;
  readonly dailyPnl: VerifiedFact<number>;
  readonly pendingOrders: VerifiedFact<PendingOrder[]>;
}

export interface Position {
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly quantity: number;
  readonly avgCost: number;
  readonly currentPrice: number;
  readonly unrealizedPnl: number;
  readonly strategy: string;            // Which strategy opened this
  readonly entryTimestamp: number;
}

export interface PendingOrder {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: number;
  readonly limitPrice: number;
  readonly status: 'submitted' | 'partial' | 'pending_cancel';
}

// ============================================================
// OPPORTUNITIES -- What Scout finds
// ============================================================

export type OpportunityType =
  | 'REG_SHO'
  | 'PEAD'
  | 'SPINOFF'
  | 'INSIDER_CLUSTER'
  | 'NET_NET'
  | 'FILING_TONE_SHIFT'
  | 'PREMARKET_ANOMALY'
  | 'TREASURY_AUCTION'
  | 'HYG_DISLOCATION';

export type Urgency = 'IMMEDIATE' | 'TODAY' | 'THIS_WEEK' | 'MONITOR';

export interface Opportunity {
  readonly id: string;                  // Unique ID for tracking
  readonly type: OpportunityType;
  readonly ticker: string;
  readonly urgency: Urgency;
  readonly detectedAt: number;          // Unix ms
  readonly data: Record<string, unknown>;  // Type-specific raw data
  readonly sourceUrl?: string;          // EDGAR link, etc.
  readonly summary: string;             // Human-readable one-liner
}

// ============================================================
// STRATEGY ACTIONS -- Typed boundary between reasoning and execution
// ============================================================

export type ActionSide = 'BUY' | 'SELL';
export type InstrumentType = 'SHARES' | 'CALL_OPTION' | 'PUT_OPTION' | 'DEBIT_SPREAD' | 'CREDIT_SPREAD';

export interface StrategyAction {
  readonly id: string;                  // Unique action ID
  readonly opportunityId: string;       // Links back to the opportunity
  readonly strategy: string;            // "pead_spread" | "reg_sho" | "net_net" etc.
  readonly ticker: string;
  readonly side: ActionSide;
  readonly instrumentType: InstrumentType;
  readonly quantity: number;            // Shares or contracts
  readonly limitPrice: number;          // Max price willing to pay
  readonly stopLoss: number;            // Hard stop
  readonly takeProfit: number;          // Target exit
  readonly maxHoldDays: number;         // Force exit after this many days
  readonly positionSizeDollars: number; // Total $ allocated
  readonly conviction: number;          // 0-100, from Analyst
  readonly rationale: string;           // Why this trade (for logging)
  readonly timestamp: number;
  // Options-specific fields (null for shares)
  readonly optionsExpiry?: string;      // "2026-05-16"
  readonly optionsStrike?: number;
  readonly spreadWidth?: number;        // For spreads
}

// ============================================================
// VERDICTS -- Constraint layer output
// ============================================================

export type VerdictType = 'PASS' | 'HOLD' | 'REJECT' | 'ESCALATE' | 'SUSPEND';

export interface Verdict {
  readonly type: VerdictType;
  readonly action: StrategyAction;
  readonly reasons: string[];           // Why this verdict
  readonly timestamp: number;
  readonly constraintsFailed: string[]; // Which specific rules failed
  readonly constraintsPassed: string[]; // Which rules passed
}

// ============================================================
// EXECUTION RESULTS
// ============================================================

export type FillStatus = 'filled' | 'partial' | 'rejected' | 'cancelled' | 'pending';

export interface ExecutionResult {
  readonly actionId: string;
  readonly orderId: string;
  readonly status: FillStatus;
  readonly filledQuantity: number;
  readonly filledPrice: number;
  readonly commission: number;
  readonly slippage: number;            // Difference from limit price
  readonly timestamp: number;
  readonly venueResponse: string;       // Raw broker response
}

// ============================================================
// TRADE RECORDS -- Closed-loop feedback
// ============================================================

export interface TradeRecord {
  readonly id: string;
  readonly opportunityId: string;
  readonly actionId: string;
  readonly strategy: string;
  readonly ticker: string;
  readonly side: ActionSide;
  readonly instrumentType: InstrumentType;
  // Entry
  readonly entryPrice: number;
  readonly entryTimestamp: number;
  readonly entryConviction: number;
  // Exit
  readonly exitPrice: number;
  readonly exitTimestamp: number;
  readonly exitReason: 'target' | 'stop' | 'time' | 'manual' | 'kill_switch';
  // Outcome
  readonly pnlDollars: number;
  readonly pnlPercent: number;
  readonly holdDays: number;
  readonly commissions: number;
  // Feedback
  readonly analystRationale: string;
  readonly verdictType: VerdictType;
  readonly constraintsFailed: string[];
}

// ============================================================
// SYSTEM CONFIG
// ============================================================

export interface GeckoConfig {
  // Account
  readonly startingCapital: number;
  readonly brokerId: 'ibkr' | 'alpaca' | 'paper';
  // API Keys (loaded from .env)
  readonly claudeApiKey: string;
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  // Trading mode
  readonly liveTrading: boolean;        // false = paper trade
  readonly maxPositionPercent: number;  // Max % of account per position (e.g., 0.12)
  readonly maxDeployedPercent: number;  // Max % of account deployed (e.g., 0.60)
  readonly dailyLossLimitPercent: number; // Daily loss limit (e.g., 0.03)
  // Strategies enabled
  readonly enableNetNet: boolean;
  readonly enableSpinoff: boolean;
  readonly enablePead: boolean;
  readonly enableRegSho: boolean;
  // Logging
  readonly logLevel: LogLevel;
}

// ============================================================
// LOG ENTRY (for structured logging)
// ============================================================

export interface LogEntry {
  readonly ts: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}
