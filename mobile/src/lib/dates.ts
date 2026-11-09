// The app keeps dates as ISO "YYYY-MM-DD" text. The native picker speaks Date, so these convert with
// local parts only: toISOString() works in UTC and would shift the day for a phone in India.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function dateToIso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${month}-${day}`;
}

// Local midnight of `iso`; `fallback` (default: now) for blank, malformed or impossible dates.
export function isoToDate(iso: string, fallback: Date = new Date()): Date {
  const match = ISO.exec(iso.trim());
  if (!match) return fallback;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : fallback;
}
