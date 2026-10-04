// relative date/time phrases → calendar dates in the org's time zone (used by the demo model's intent parser)

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

export type DateRange = { from: string; to: string; label: string };

// finds the first date expression in the text; null when there is none
export function parseDateRange(text: string, today: string): DateRange | null {
  const t = text.toLowerCase();
  const iso = t.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return { from: iso[1], to: iso[1], label: iso[1] };
  if (/\bday after tomorrow\b/.test(t)) {
    const d = addDaysIso(today, 2);
    return { from: d, to: d, label: d };
  }
  if (/\btomorrow\b|\btmrw\b/.test(t)) {
    const d = addDaysIso(today, 1);
    return { from: d, to: d, label: "tomorrow" };
  }
  if (/\byesterday\b/.test(t)) {
    const d = addDaysIso(today, -1);
    return { from: d, to: d, label: "yesterday" };
  }
  if (/\b(today|tonight|this morning|this afternoon|this evening)\b/.test(t)) return { from: today, to: today, label: "today" };
  if (/\bnext week\b/.test(t)) {
    const start = addDaysIso(today, ((8 - weekday(today)) % 7) || 7); // next Monday
    return { from: start, to: addDaysIso(start, 6), label: "next week" };
  }
  if (/\b(this week|past week|last 7 days|last week)\b/.test(t)) {
    if (/\b(past week|last 7 days|last week)\b/.test(t)) return { from: addDaysIso(today, -7), to: today, label: "the last 7 days" };
    return { from: addDaysIso(today, -((weekday(today) + 6) % 7)), to: addDaysIso(today, 6 - ((weekday(today) + 6) % 7)), label: "this week" };
  }
  if (/\b(this month|past month|last 30 days)\b/.test(t)) return { from: addDaysIso(today, -30), to: today, label: "the last 30 days" };
  const wd = t.match(/\b(?:(next|this|on)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[2]);
    let diff = (target - weekday(today) + 7) % 7;
    if (wd[1] === "next" && diff === 0) diff = 7;
    const d = addDaysIso(today, diff);
    return { from: d, to: d, label: wd[2][0].toUpperCase() + wd[2].slice(1) };
  }
  const md = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (md) {
    const month = MONTHS.indexOf(md[1]) + 1;
    const year = Number(today.slice(0, 4));
    let d = `${year}-${String(month).padStart(2, "0")}-${md[2].padStart(2, "0")}`;
    if (d < addDaysIso(today, -180)) d = `${year + 1}${d.slice(4)}`;
    return { from: d, to: d, label: d };
  }
  return null;
}

// "7 PM", "7:30pm", "19:00", "at 7" (bare 1–7 read as evening) → "HH:MM"
export function parseTime(text: string): string | null {
  const t = text.toLowerCase();
  const ampm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3].startsWith("p")) h += 12;
    if (h > 23 || Number(ampm[2] ?? 0) > 59) return null;
    return `${String(h).padStart(2, "0")}:${ampm[2] ?? "00"}`;
  }
  const hm = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (hm) return `${hm[1].padStart(2, "0")}:${hm[2]}`;
  if (/\bnoon\b/.test(t)) return "12:00";
  const bare = t.match(/\bat\s+(\d{1,2})\b(?!\s*(?:days?|units?|people|guests|%))/);
  if (bare) {
    const h = Number(bare[1]);
    if (h >= 1 && h <= 7) return `${String(h + 12).padStart(2, "0")}:00`;
    if (h >= 8 && h <= 23) return `${String(h).padStart(2, "0")}:00`;
  }
  return null;
}

// "for 2 hours", "for 90 minutes"
export function parseDuration(text: string): number | null {
  const t = text.toLowerCase();
  const h = t.match(/\bfor\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
  if (h) return Math.round(Number(h[1]) * 60);
  const m = t.match(/\bfor\s+(\d+)\s*(?:minutes?|mins?|m)\b/);
  if (m) return Number(m[1]);
  return null;
}
