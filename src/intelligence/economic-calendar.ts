// Economic calendar: knows about scheduled US macro releases that cause
// gap-and-reverse fakeouts at the 9:30 ET equity open.
//
// Strategies can call shouldSkipToday(strategy) to decide whether to suppress
// signals on a given date. ORB is the main consumer — its 9:30-9:45 OR is
// distorted by 8:30 ET surprise releases when the cash market re-opens and
// fades the pre-market move.
//
// Schedule sources (built-in, no network calls):
//   - NFP: first Friday of each month, 8:30 ET (BLS Employment Situation)
//   - CPI: typically the 2nd or 3rd Wednesday, 8:30 ET (BLS CPI)
//   - PCE: last Friday of each month, 8:30 ET (BEA Personal Income)
//   - FOMC press conferences: 8 per year, ~6 weeks apart
//   - Major bank earnings days are NOT included (too granular for this)
//
// For the next 18 months we hardcode the exact known dates. A future
// improvement: pull from an economic calendar API daily.

import { etParts } from "../utils/time.js";

// Hardcoded high-impact US macro release dates 2026 (mostly 8:30 ET).
// Sourced from BLS / BEA / FOMC public schedules.
// Each entry is YYYY-MM-DD.
const NFP_DATES_2026: readonly string[] = [
  "2026-01-09", "2026-02-06", "2026-03-06", "2026-04-03", "2026-05-02",
  "2026-06-05", "2026-07-02", "2026-08-07", "2026-09-04", "2026-10-02",
  "2026-11-06", "2026-12-04",
];

const CPI_DATES_2026: readonly string[] = [
  "2026-01-14", "2026-02-11", "2026-03-11", "2026-04-10", "2026-05-13",
  "2026-06-10", "2026-07-15", "2026-08-12", "2026-09-10", "2026-10-15",
  "2026-11-13", "2026-12-10",
];

const FOMC_DATES_2026: readonly string[] = [
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
  "2026-07-29", "2026-09-16", "2026-11-04", "2026-12-09",
];

// PCE release dates (less impactful than CPI/NFP; included for completeness)
const PCE_DATES_2026: readonly string[] = [
  "2026-01-30", "2026-02-27", "2026-03-27", "2026-04-30", "2026-05-29",
  "2026-06-26", "2026-07-31", "2026-08-28", "2026-09-25", "2026-10-30",
  "2026-11-25", "2026-12-23",
];

export interface MacroEvent {
  readonly date: string;
  readonly type: "NFP" | "CPI" | "FOMC" | "PCE";
  readonly impact: "HIGH" | "MEDIUM";
}

const ALL_EVENTS: readonly MacroEvent[] = [
  ...NFP_DATES_2026.map((date) => ({ date, type: "NFP" as const, impact: "HIGH" as const })),
  ...CPI_DATES_2026.map((date) => ({ date, type: "CPI" as const, impact: "HIGH" as const })),
  ...FOMC_DATES_2026.map((date) => ({ date, type: "FOMC" as const, impact: "HIGH" as const })),
  ...PCE_DATES_2026.map((date) => ({ date, type: "PCE" as const, impact: "MEDIUM" as const })),
];

const EVENT_BY_DATE = new Map<string, MacroEvent[]>();
for (const e of ALL_EVENTS) {
  const arr = EVENT_BY_DATE.get(e.date) ?? [];
  arr.push(e);
  EVENT_BY_DATE.set(e.date, arr);
}

export class EconomicCalendar {
  // Returns true if today (ET) is a high-impact macro release day.
  // ORB callers use this to suppress signals — the 9:30 ET open following
  // an 8:30 ET surprise has historically produced fakeout breakouts.
  isHighImpactDay(date?: string): boolean {
    const d = date ?? etParts().date;
    const events = EVENT_BY_DATE.get(d) ?? [];
    return events.some((e) => e.impact === "HIGH");
  }

  // All events on a given ET date.
  eventsOn(date?: string): readonly MacroEvent[] {
    const d = date ?? etParts().date;
    return EVENT_BY_DATE.get(d) ?? [];
  }

  // Convenience: skip ORB on high-impact days. Other strategies may have
  // their own per-event handling (e.g. catalyst trader targets these).
  shouldSkipOrb(date?: string): boolean {
    return this.isHighImpactDay(date);
  }
}
