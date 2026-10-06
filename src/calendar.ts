// US Central civil time, including post-2007 US daylight saving rules.
// All calculations use UTC primitives, never the Worker's local timezone.
const MINUTE = 60_000;
function sunday(year: number, month: number, nth: number): number {
  return (
    1 +
    ((7 - new Date(Date.UTC(year, month, 1)).getUTCDay()) % 7) +
    (nth - 1) * 7
  );
}
export function centralOffset(at: number): number {
  const year = new Date(at).getUTCFullYear();
  const start = Date.UTC(year, 2, sunday(year, 2, 2), 8);
  const end = Date.UTC(year, 10, sunday(year, 10, 1), 7);
  return at >= start && at < end ? -5 : -6;
}
export function localDate(at: number): Date {
  return new Date(at + centralOffset(at) * 3_600_000);
}
export function centralTime(
  year: number,
  month: number,
  day: number,
  hour: number,
): number {
  const approx = Date.UTC(year, month, day, hour + 6);
  return Date.UTC(year, month, day, hour) - centralOffset(approx) * 3_600_000;
}
export function businessBounds(at: number): {
  open: number;
  close: number;
  sunday: boolean;
} {
  const d = localDate(at);
  return {
    open: centralTime(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9),
    close: centralTime(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 19),
    sunday: d.getUTCDay() === 0,
  };
}
export function nextBusinessTime(at: number): number {
  let cursor = at;
  for (let i = 0; i < 8; i++) {
    const b = businessBounds(cursor);
    if (!b.sunday && cursor < b.close) return Math.max(cursor, b.open);
    const d = localDate(cursor);
    cursor = centralTime(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() + 1,
      9,
    );
  }
  throw new Error("Could not find business day");
}
export function addBusinessMinutes(at: number, minutes: number): number {
  let cursor = nextBusinessTime(at),
    remaining = minutes * MINUTE;
  while (remaining > 0) {
    const { close } = businessBounds(cursor);
    const consumed = Math.min(remaining, close - cursor);
    cursor += consumed;
    remaining -= consumed;
    if (remaining > 0) cursor = nextBusinessTime(cursor);
  }
  return cursor;
}
export function sameCentralDay(a: number, b: number): boolean {
  return (
    localDate(a).toISOString().slice(0, 10) ===
    localDate(b).toISOString().slice(0, 10)
  );
}
export function centralLabel(at: number): string {
  const d = localDate(at),
    hour = d.getUTCHours();
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} at ${hour % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"} Central`;
}
