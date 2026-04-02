export function nowMs(): number {
  return Date.now();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function msSince(timestamp: number): number {
  return Date.now() - timestamp;
}

export function msUntil(timestamp: number): number {
  return timestamp - Date.now();
}

export function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
