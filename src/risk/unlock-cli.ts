// CLI: clear the kill-switch lock file.
//
// Usage:
//   npm run unlock -- --by="chris" --reason="reviewed weekly DD, false-trip on tickle 401"
//
// Refuses to clear unless both --by and --reason are provided. Writes the
// unlock event to data/audit.jsonl. This is the intentional friction
// preventing a panicked `pm2 restart` from clearing real risk events.

import { argv, exit, stderr, stdout } from "node:process";
import { clear, isLocked, readLock } from "./kill-switch-lock.js";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function main(): void {
  if (!isLocked()) {
    stdout.write("No kill-switch lock file present. Nothing to clear.\n");
    exit(0);
  }

  const by = arg("by");
  const reason = arg("reason");
  if (!by || !reason) {
    stderr.write("Usage: npm run unlock -- --by=\"<name>\" --reason=\"<justification>\"\n");
    stderr.write("Both --by and --reason are required.\n\n");
    const lock = readLock();
    if (lock) {
      stderr.write(`Current lock:\n`);
      stderr.write(`  source:    ${lock.source}\n`);
      stderr.write(`  reason:    ${lock.reason}\n`);
      stderr.write(`  timestamp: ${lock.timestamp}\n`);
    }
    exit(1);
  }

  clear(by, reason);
  stdout.write("Kill switch cleared. Bot may now resume on next start.\n");
}

main();
