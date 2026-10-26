/** Wall clock time in a time zone, without a date library. */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface WallTime {
  year: number;
  month: number;
  day: number;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  hour: number;
  minute: number;
  second: number;
  /** YYYY-MM-DD */
  date: string;
  /** Minutes after midnight. */
  minuteOfDay: number;
}

export function wallTime(t: number, tz: string): WallTime {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(t))) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    year,
    month,
    day,
    weekday: WEEKDAYS[parts.weekday!] ?? 1,
    hour,
    minute,
    second: Number(parts.second),
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: hour * 60 + minute,
  };
}

/** Start of the wall clock hour that `t` is in. */
export function hourStart(t: number, tz: string) {
  const w = wallTime(t, tz);
  return t - (w.minute * 60 + w.second) * 1000 - (((t % 1000) + 1000) % 1000);
}

/** The instant of a wall clock time (date YYYY-MM-DD, minutes after midnight) in a time zone. */
export function zonedInstant(date: string, minuteOfDay: number, tz: string) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wanted = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  let t = wanted;
  // Two rounds find the offset, also next to a daylight saving change.
  for (let i = 0; i < 2; i++) {
    const w = wallTime(t, tz);
    const seen = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    t += wanted - seen;
  }
  return t;
}

/** The date `days` after a date (YYYY-MM-DD). */
export function addDays(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** ISO weekday (1 = Monday) of a date. */
export function weekdayOf(date: string) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}
