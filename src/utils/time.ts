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

// -- Market hours (US Eastern, DST-aware via Intl) --

const ET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

interface EtParts {
  readonly date: string;     // YYYY-MM-DD
  readonly hour: number;     // 0-23
  readonly minute: number;   // 0-59
  readonly second: number;   // 0-59
  readonly dayOfWeek: number; // 0=Sun .. 6=Sat
}

export function etParts(ts: number = Date.now()): EtParts {
  const parts = ET_FORMATTER.formatToParts(new Date(ts));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "0";

  // Intl returns hour "24" at midnight in some locales; normalize to 0.
  const rawHour = Number(get("hour"));
  const hour = rawHour === 24 ? 0 : rawHour;

  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const minute = Number(get("minute"));
  const second = Number(get("second"));

  // Compute day-of-week from the ET date string (consistent across DST).
  const dt = new Date(`${date}T00:00:00Z`);
  const dayOfWeek = dt.getUTCDay();

  return { date, hour, minute, second, dayOfWeek };
}

// True iff currently a US market weekday (Mon-Fri ET, holidays NOT checked).
export function isWeekdayET(ts: number = Date.now()): boolean {
  const { dayOfWeek } = etParts(ts);
  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

// True during regular US equities session (9:30 - 16:00 ET on a weekday).
export function isRegularSession(ts: number = Date.now()): boolean {
  const p = etParts(ts);
  if (p.dayOfWeek < 1 || p.dayOfWeek > 5) return false;
  const mins = p.hour * 60 + p.minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// True during US premarket (4:00 - 9:30 ET on a weekday).
export function isPremarket(ts: number = Date.now()): boolean {
  const p = etParts(ts);
  if (p.dayOfWeek < 1 || p.dayOfWeek > 5) return false;
  const mins = p.hour * 60 + p.minute;
  return mins >= 4 * 60 && mins < 9 * 60 + 30;
}

// True during after-hours (16:00 - 20:00 ET on a weekday).
export function isAfterHours(ts: number = Date.now()): boolean {
  const p = etParts(ts);
  if (p.dayOfWeek < 1 || p.dayOfWeek > 5) return false;
  const mins = p.hour * 60 + p.minute;
  return mins >= 16 * 60 && mins < 20 * 60;
}

// Today's ET date as YYYY-MM-DD.
export function etDate(ts: number = Date.now()): string {
  return etParts(ts).date;
}
