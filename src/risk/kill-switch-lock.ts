// Filesystem-backed kill switch with friction.
//
// When an uncaught error trips the bot or the operator manually halts, we
// write a sentinel file. On startup, the bot refuses to run while the
// sentinel exists. The only way to clear it is for the operator to delete
// the file manually (or run `npm run unlock`). This prevents an
// emotional `pm2 restart gecko-bot` from clearing a real risk event.
//
// Per the council's ops review (finding #5): "Kill-switch reset has no
// friction. Operator on phone, frustrated, restarts PM2 to 'clear it.'
// Bot re-arms and resumes trading the same losing regime."

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../core/logger.js";

const log = createLogger("kill-switch-lock");
const LOCK_FILE = "data/kill-switch.lock";
const AUDIT_FILE = "data/audit.jsonl";

export interface KillSwitchReason {
  readonly timestamp: string;
  readonly source: "uncaught-exception" | "unhandled-rejection" | "daily-stop" | "weekly-stop" | "monthly-stop" | "peak-to-trough" | "reconciliation-mismatch" | "manual" | "gateway-down" | "broker-disconnect";
  readonly reason: string;
  readonly stack?: string;
}

export function isLocked(): boolean {
  return fs.existsSync(LOCK_FILE);
}

export function readLock(): KillSwitchReason | null {
  if (!fs.existsSync(LOCK_FILE)) return null;
  try {
    const raw = fs.readFileSync(LOCK_FILE, "utf-8");
    return JSON.parse(raw) as KillSwitchReason;
  } catch (err) {
    log.error("Kill-switch lock file exists but is unreadable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { timestamp: new Date().toISOString(), source: "manual", reason: "unreadable lock file" };
  }
}

export function trip(reason: KillSwitchReason): void {
  try {
    const dir = path.dirname(LOCK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify(reason, null, 2), { encoding: "utf-8", mode: 0o600 });
    appendAudit({ event: "kill-switch-tripped", ...reason });
    log.error("KILL SWITCH TRIPPED — bot will not trade until data/kill-switch.lock is removed", reason as unknown as Record<string, unknown>);
  } catch (err) {
    log.error("Failed to write kill-switch lock file", {
      error: err instanceof Error ? err.message : String(err),
      reason,
    });
  }
}

export function clear(unlockedBy: string, justification: string): void {
  if (!fs.existsSync(LOCK_FILE)) {
    log.warn("Kill-switch clear requested but no lock file present");
    return;
  }
  const prior = readLock();
  try {
    fs.unlinkSync(LOCK_FILE);
    appendAudit({ event: "kill-switch-cleared", unlockedBy, justification, prior });
    log.warn("Kill switch cleared", { unlockedBy, justification, priorReason: prior?.reason });
  } catch (err) {
    log.error("Failed to clear kill-switch lock file", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function appendAudit(entry: Record<string, unknown>): void {
  try {
    const dir = path.dirname(AUDIT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFileSync(AUDIT_FILE, line, "utf-8");
  } catch {
    // Best-effort; do not throw from audit path.
  }
}
