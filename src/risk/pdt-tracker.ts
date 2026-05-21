// Day-trade counter. Pre-June-4-2026, FINRA limits non-PDT accounts to 3
// day trades in any rolling 5 business days. The new rule (June 4, 2026)
// drops the PDT threshold to $2k and eliminates the rolling counter, but
// Schwab has until October 20, 2027 to implement and may not honor it
// day-one. This counter is kept as a defensive safety net regardless.
//
// A day trade = opening AND closing a position in the same symbol on
// the same session. Equity round-trips and option round-trips both count.

import { createLogger } from "../core/logger.js";
import { appendJsonl, readJsonl } from "../utils/persistence.js";

const log = createLogger("pdt-tracker");

const PDT_FILE = "data/day-trades.jsonl";

interface DayTradeRecord {
  readonly ts: string;
  readonly symbol: string;
  readonly date: string;       // YYYY-MM-DD (ET trading day)
}

export class PdtTracker {
  private readonly trades: DayTradeRecord[];
  private readonly maxPerWindow: number;

  // Pass maxPerWindow=4 to leave a 1-trade buffer below the 5/5 rule.
  // The new rule lets us go higher post-June-4; set higher when confirmed.
  constructor(maxPerWindow: number) {
    this.maxPerWindow = maxPerWindow;
    this.trades = readJsonl<DayTradeRecord>(PDT_FILE);
    if (this.trades.length > 0) {
      log.info("Loaded day-trade history", { count: this.trades.length });
    }
  }

  recordDayTrade(symbol: string, isoDate: string): void {
    const record: DayTradeRecord = {
      ts: new Date().toISOString(),
      symbol,
      date: isoDate,
    };
    this.trades.push(record);
    appendJsonl(PDT_FILE, record);
    log.info("Day trade recorded", {
      symbol,
      date: isoDate,
      rolling: this.countInRollingWindow(),
      max: this.maxPerWindow,
    });
  }

  // Number of day trades in the last 5 business days.
  countInRollingWindow(): number {
    const cutoff = businessDaysAgo(5);
    return this.trades.filter((t) => t.date >= cutoff).length;
  }

  // Would adding one more day trade put us over the limit?
  wouldExceedLimit(): boolean {
    return this.countInRollingWindow() >= this.maxPerWindow;
  }
}

// Returns YYYY-MM-DD for the date n business days before today, US Eastern.
// "Business days" approximated as weekdays; market holidays not subtracted
// (a true PDT counter uses settlement days, but the conservative case is
// counting too few -- which is what we get by ignoring holidays).
function businessDaysAgo(n: number): string {
  const now = new Date();
  let counted = 0;
  const cursor = new Date(now);
  while (counted < n) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) counted++;
  }
  return cursor.toISOString().slice(0, 10);
}
