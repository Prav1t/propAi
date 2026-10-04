// converts a wall-clock "YYYY-MM-DDTHH:mm" in an IANA time zone to a UTC Date (DST-safe)
export function zonedToUtc(local: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return new Date(NaN);
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // offset of the zone at that instant, refined once to handle DST boundaries
  const offset = (t: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(t)).reduce<Record<string, string>>((a, p) => ((a[p.type] = p.value), a), {});
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - t;
  };
  let t = asUtc - offset(asUtc);
  t = asUtc - offset(t);
  return new Date(t);
}

// formats a Date as "YYYY-MM-DDTHH:mm" in a time zone (for datetime-local inputs)
export function utcToZonedInput(d: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(d).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function fmtDateTime(d: Date | null | undefined, timeZone: string) {
  return d ? d.toLocaleString("en-CA", { timeZone, dateStyle: "medium", timeStyle: "short" }) : "—";
}

// "in 3h", "2d ago"
export function relative(d: Date, now = new Date()): string {
  const diff = d.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const unit = abs < 3_600_000 ? [Math.round(abs / 60_000), "m"] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), "h"] : [Math.round(abs / 86_400_000), "d"];
  return diff >= 0 ? `in ${unit[0]}${unit[1]}` : `${unit[0]}${unit[1]} ago`;
}

// "Sat, Oct 4, 6:00 p.m.–11:00 p.m." (same day) or "Oct 4, 6:00 p.m. – Oct 6, 11:00 a.m."
export function fmtRange(from: Date, until: Date, timeZone: string) {
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone, weekday: "short", month: "short", day: "numeric" });
  const time = (d: Date) => d.toLocaleTimeString("en-CA", { timeZone, hour: "numeric", minute: "2-digit" });
  return day(from) === day(until) ? `${day(from)}, ${time(from)}–${time(until)}` : `${day(from)}, ${time(from)} – ${day(until)}, ${time(until)}`;
}

// YYYY-MM-DD and HH:mm of a moment in a time zone
export function zonedParts(d: Date, timeZone: string) {
  const s = utcToZonedInput(d, timeZone);
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}
