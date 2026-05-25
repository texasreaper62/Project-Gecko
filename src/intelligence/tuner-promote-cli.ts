// CLI to review and promote self-tuner proposals.
//
// Usage:
//   npm run tuner:list                # list pending proposals
//   npm run tuner:promote -- --id=<n> # apply proposal #n
//
// Pending proposals live in data/tuner-proposals.jsonl. Applying a proposal
// writes the change into data/tuning-state.jsonl (the tuner's live state)
// and marks the proposal as applied in the audit log.

import * as fs from "node:fs";
import { argv, stderr, stdout, exit } from "node:process";
import { appendJsonl } from "../utils/persistence.js";

const PROPOSALS_FILE = "data/tuner-proposals.jsonl";
const TUNING_FILE = "data/tuning-state.jsonl";
const AUDIT_FILE = "data/audit.jsonl";

interface Proposal {
  ts: string;
  field: string;
  fromValue: number | boolean;
  toValue: number | boolean;
  justification: Record<string, unknown>;
  applied: boolean;
}

function loadProposals(): Proposal[] {
  if (!fs.existsSync(PROPOSALS_FILE)) return [];
  const lines = fs.readFileSync(PROPOSALS_FILE, "utf-8").split("\n").filter((l) => l.trim());
  const out: Proposal[] = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line) as Proposal); } catch { /* skip */ }
  }
  return out;
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function list(): void {
  const proposals = loadProposals();
  const pending = proposals.filter((p) => !p.applied);
  if (pending.length === 0) {
    stdout.write("No pending tuner proposals.\n");
    return;
  }
  stdout.write(`${pending.length} pending tuner proposal(s):\n\n`);
  proposals.forEach((p, i) => {
    if (p.applied) return;
    stdout.write(`#${i}  ${p.ts}\n`);
    stdout.write(`     field:    ${p.field}\n`);
    stdout.write(`     change:   ${JSON.stringify(p.fromValue)} -> ${JSON.stringify(p.toValue)}\n`);
    stdout.write(`     because:  ${JSON.stringify(p.justification)}\n\n`);
  });
  stdout.write("Apply with: npm run tuner:promote -- --id=<n>\n");
}

function promote(): void {
  const idStr = arg("id");
  if (!idStr) {
    stderr.write("Usage: npm run tuner:promote -- --id=<n>\n");
    exit(1);
  }
  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 0) {
    stderr.write(`Invalid id: ${idStr}\n`);
    exit(1);
  }
  const proposals = loadProposals();
  if (id >= proposals.length) {
    stderr.write(`No proposal #${id} (have ${proposals.length}).\n`);
    exit(1);
  }
  const p = proposals[id];
  if (p.applied) {
    stderr.write(`Proposal #${id} already applied.\n`);
    exit(1);
  }

  // Write the change as an entry into the tuner state log. SelfTuner reads
  // the latest entry on startup as its initial state. We don't need to
  // know the full state shape here — just append the field-level delta;
  // the tuner's loader merges entries forward.
  const promotedEntry = {
    ts: new Date().toISOString(),
    promotedProposal: { id, field: p.field, fromValue: p.fromValue, toValue: p.toValue },
    fieldUpdate: { [p.field]: p.toValue },
  };
  appendJsonl(TUNING_FILE, promotedEntry);
  appendJsonl(AUDIT_FILE, { event: "tuner-proposal-promoted", proposalId: id, proposal: p });

  // Mark the proposal applied by rewriting the proposals file.
  proposals[id] = { ...p, applied: true };
  const lines = proposals.map((q) => JSON.stringify(q)).join("\n") + "\n";
  fs.writeFileSync(PROPOSALS_FILE, lines, "utf-8");

  stdout.write(`Proposal #${id} promoted. Restart the bot for the change to take effect.\n`);
}

function main(): void {
  if (argv.includes("--list") || argv[1].endsWith("tuner-list-cli.ts")) {
    list();
    return;
  }
  if (arg("id")) {
    promote();
    return;
  }
  list();
}

main();
