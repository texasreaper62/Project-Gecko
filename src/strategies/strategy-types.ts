import type { Opportunity, StrategyState, StrategyType } from "../core/types.js";

export interface Strategy {
  readonly name: StrategyType;
  readonly state: StrategyState;
  scan(): Promise<Opportunity[]>;
  start(): void;
  stop(): void;
}

export interface TemporalArbSignal {
  readonly market: string;
  readonly conditionId: string;
  readonly tokenId: string;
  readonly spotPrice: number;
  readonly contractPrice: number;
  readonly estimatedTrueProb: number;
  readonly marketProb: number;
  readonly edgePercent: number;
  readonly direction: "BUY_YES" | "BUY_NO";
  readonly spotMomentum: number;      // $/ms rate of change
  readonly confidence: number;
  readonly timestamp: number;
}

export interface CorrelatedContractSignal {
  readonly eventSlug: string;
  readonly eventTitle: string;
  readonly outcomes: readonly {
    readonly conditionId: string;
    readonly tokenId: string;
    readonly question: string;
    readonly yesPrice: number;
  }[];
  readonly sumYesPrices: number;
  readonly deviation: number;          // How far from 1.0
  readonly type: "OVERPRICED" | "UNDERPRICED";
  readonly mostMispriced: {
    readonly conditionId: string;
    readonly tokenId: string;
    readonly question: string;
    readonly price: number;
  };
  readonly timestamp: number;
}

export interface CrossPlatformSignal {
  readonly polymarketMarket: string;
  readonly kalshiMarket: string;
  readonly polymarketYesPrice: number;
  readonly kalshiYesPrice: number;
  readonly polymarketNoPrice: number;
  readonly kalshiNoPrice: number;
  readonly combinedCost: number;       // Should be < 1.0 for arb
  readonly profit: number;
  readonly timestamp: number;
}
