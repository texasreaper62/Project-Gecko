// Shared strategy interface.
//
// Strategies subscribe to live ticks via a callback (wired by index.ts).
// On a trigger, they emit a TradeSignal which the OrderRouter consumes.
// Strategies do NOT submit orders themselves; they only describe intent.

import type { TradeSignal } from "../core/types.js";

export interface Strategy {
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
  setSignalHandler(handler: (signal: TradeSignal) => void): void;
}
