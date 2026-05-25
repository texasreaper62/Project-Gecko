// Drawdown tracker: weekly, monthly, and peak-to-trough equity limits.
//
// The daily -3% stop in DailyStop is an in-session halt that auto-resets
// next morning. This class enforces longer-horizon limits the council ops
// review required: weekly -6%, monthly -10%, peak-to-trough -20%. On trip,
// it writes to data/kill-switch.lock with an auto-clear cooldown (48h for
// weekly, 7d for monthly) or no cooldown at all (peak-to-trough requires
// manual unlock + plan re-pitch).
//
// State persists to data/risk-state.json so the bot survives restarts
// without losing track of week/month start equity or the all-time peak.

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";
import { trip as tripKillSwitch } from "./kill-switch-lock.js";

const log = createLogger("drawdown-tracker");

const STATE_FILE = "data/risk-state.json";
const WEEKLY_PCT = 6;
const MONTHLY_PCT = 10;
const PEAK_TO_TROUGH_PCT = 20;
const WEEKLY_COOLDOWN_MS = 48 * 60 * 60 * 1000;
const MONTHLY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

interface RiskState {
  weekStartEquity: number;
  weekStartIso: string;        // YYYY-MM-DD of Monday
  monthStartEquity: number;
  monthStartIso: string;       // YYYY-MM of month start
  peakEquity: number;
  peakIso: string;
  // True once we've tripped at this horizon during the current period.
  // Cleared when the period rolls over.
  weeklyTripped: boolean;
  monthlyTripped: boolean;
  peakToTroughTripped: boolean;
}

export class DrawdownTracker {
  private state: RiskState;

  constructor() {
    this.state = loadState();
  }

  // Called once on every account snapshot refresh. Updates rolling window
  // baselines, refreshes the peak, and evaluates each threshold. On trip,
  // calls tripKillSwitch with an appropriate cooldown.
  update(currentEquity: number, nowMs: number = Date.now()): void {
    if (!Number.isFinite(currentEquity) || currentEquity <= 0) return;

    const now = new Date(nowMs);
    const todayIso = etDateIso(now);
    const weekIso = mondayIso(now);
    const monthIso = monthStartIso(now);

    // Initialize on first-ever call.
    if (this.state.peakEquity <= 0) {
      this.state.peakEquity = currentEquity;
      this.state.peakIso = todayIso;
      this.state.weekStartEquity = currentEquity;
      this.state.weekStartIso = weekIso;
      this.state.monthStartEquity = currentEquity;
      this.state.monthStartIso = monthIso;
      persistState(this.state);
      log.info("Drawdown tracker initialized", { equity: currentEquity });
      return;
    }

    // Roll forward if we've crossed a week/month boundary.
    if (weekIso !== this.state.weekStartIso) {
      log.info("Weekly baseline rolled forward", {
        prevWeekStart: this.state.weekStartIso,
        prevWeekStartEquity: this.state.weekStartEquity,
        newWeekStart: weekIso,
        newWeekStartEquity: currentEquity,
      });
      this.state.weekStartIso = weekIso;
      this.state.weekStartEquity = currentEquity;
      this.state.weeklyTripped = false;
    }
    if (monthIso !== this.state.monthStartIso) {
      log.info("Monthly baseline rolled forward", {
        prevMonthStart: this.state.monthStartIso,
        prevMonthStartEquity: this.state.monthStartEquity,
        newMonthStart: monthIso,
        newMonthStartEquity: currentEquity,
      });
      this.state.monthStartIso = monthIso;
      this.state.monthStartEquity = currentEquity;
      this.state.monthlyTripped = false;
    }

    // Update peak if current equity is a new all-time high.
    if (currentEquity > this.state.peakEquity) {
      this.state.peakEquity = currentEquity;
      this.state.peakIso = todayIso;
    }

    // Evaluate each threshold. Trip ONCE per period; subsequent updates
    // skip re-tripping (the kill-switch lock file is already present).
    if (!this.state.weeklyTripped) {
      const weeklyDdPct = (currentEquity - this.state.weekStartEquity) / this.state.weekStartEquity * 100;
      if (weeklyDdPct <= -WEEKLY_PCT) {
        this.state.weeklyTripped = true;
        const reason = `Weekly drawdown ${weeklyDdPct.toFixed(2)}% below week-start equity $${this.state.weekStartEquity.toFixed(2)} (threshold -${WEEKLY_PCT}%). 48h cooldown.`;
        log.error("WEEKLY DRAWDOWN TRIPPED", { weeklyDdPct: weeklyDdPct.toFixed(2), currentEquity, weekStart: this.state.weekStartEquity });
        tripKillSwitch({
          timestamp: new Date(nowMs).toISOString(),
          source: "weekly-stop",
          reason,
          cooldownUntilMs: nowMs + WEEKLY_COOLDOWN_MS,
        });
      }
    }
    if (!this.state.monthlyTripped) {
      const monthlyDdPct = (currentEquity - this.state.monthStartEquity) / this.state.monthStartEquity * 100;
      if (monthlyDdPct <= -MONTHLY_PCT) {
        this.state.monthlyTripped = true;
        const reason = `Monthly drawdown ${monthlyDdPct.toFixed(2)}% below month-start equity $${this.state.monthStartEquity.toFixed(2)} (threshold -${MONTHLY_PCT}%). 7-day cooldown.`;
        log.error("MONTHLY DRAWDOWN TRIPPED", { monthlyDdPct: monthlyDdPct.toFixed(2), currentEquity, monthStart: this.state.monthStartEquity });
        tripKillSwitch({
          timestamp: new Date(nowMs).toISOString(),
          source: "monthly-stop",
          reason,
          cooldownUntilMs: nowMs + MONTHLY_COOLDOWN_MS,
        });
      }
    }
    if (!this.state.peakToTroughTripped) {
      const peakDdPct = (currentEquity - this.state.peakEquity) / this.state.peakEquity * 100;
      if (peakDdPct <= -PEAK_TO_TROUGH_PCT) {
        this.state.peakToTroughTripped = true;
        const reason = `Peak-to-trough drawdown ${peakDdPct.toFixed(2)}% from all-time peak $${this.state.peakEquity.toFixed(2)} (threshold -${PEAK_TO_TROUGH_PCT}%). Permanent halt; manual unlock + plan re-pitch required.`;
        log.error("PEAK-TO-TROUGH DRAWDOWN TRIPPED", { peakDdPct: peakDdPct.toFixed(2), currentEquity, peak: this.state.peakEquity });
        tripKillSwitch({
          timestamp: new Date(nowMs).toISOString(),
          source: "peak-to-trough",
          reason,
          // No cooldownUntilMs = manual unlock required.
        });
      }
    }

    persistState(this.state);
  }

  getState(): Readonly<RiskState> {
    return this.state;
  }
}

function loadState(): RiskState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Partial<RiskState>;
      return {
        weekStartEquity: parsed.weekStartEquity ?? 0,
        weekStartIso: parsed.weekStartIso ?? "",
        monthStartEquity: parsed.monthStartEquity ?? 0,
        monthStartIso: parsed.monthStartIso ?? "",
        peakEquity: parsed.peakEquity ?? 0,
        peakIso: parsed.peakIso ?? "",
        weeklyTripped: parsed.weeklyTripped ?? false,
        monthlyTripped: parsed.monthlyTripped ?? false,
        peakToTroughTripped: parsed.peakToTroughTripped ?? false,
      };
    }
  } catch (err) {
    log.warn("Failed to load risk state; starting fresh", { error: err instanceof Error ? err.message : String(err) });
  }
  return {
    weekStartEquity: 0,
    weekStartIso: "",
    monthStartEquity: 0,
    monthStartIso: "",
    peakEquity: 0,
    peakIso: "",
    weeklyTripped: false,
    monthlyTripped: false,
    peakToTroughTripped: false,
  };
}

function persistState(state: RiskState): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    log.warn("Failed to persist risk state", { error: err instanceof Error ? err.message : String(err) });
  }
}

// YYYY-MM-DD using ET so a day boundary aligns with market session.
function etDateIso(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}

// YYYY-MM of ET month start (used as the monthly baseline key).
function monthStartIso(d: Date): string {
  return etDateIso(d).slice(0, 7);
}

// ISO date of the Monday on or before d (ET). Used as the weekly baseline key.
function mondayIso(d: Date): string {
  const iso = etDateIso(d);
  const [y, m, day] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  const dow = dt.getUTCDay();                       // 0=Sun..6=Sat
  const offset = (dow + 6) % 7;                     // days back to Monday
  dt.setUTCDate(dt.getUTCDate() - offset);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
