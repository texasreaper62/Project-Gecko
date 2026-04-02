import type { Opportunity, TradeParams, StrategyType } from "../core/types.js";

export interface StrategyEngine {
  readonly name: StrategyType;
  start(): void;
  stop(): void;
  scan(): Promise<Opportunity[]>;
}

export type OpportunityCallback = (opportunity: Opportunity) => void;

// Generate a unique ID for an opportunity
let counter = 0;
export function generateOpportunityId(strategy: StrategyType): string {
  counter++;
  return `${strategy}-${Date.now()}-${counter}`;
}
