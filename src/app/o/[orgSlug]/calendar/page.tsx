import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { availableSources, calendarEvents, CAL_SOURCE_LABEL, type CalEvent, type CalSource } from "@/server/modules/calendar/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { addDays } from "@/server/modules/assets/schedule";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { zonedParts, zonedToUtc } from "@/lib/time";

export const metadata = { title: "Calendar" };

const VIEWS = ["month", "week", "day", "agenda"] as const;
type View = (typeof VIEWS)[number];
const TAG: Record<CalSource, string> = { work: "Work", inspections: "Inspection", pm: "PM", bookings: "Booking", visitors: "Visitor", shifts: "Shift", tasks: "Task due" };

function Chip({ e, tz, compact }: { e: CalEvent; tz: string; compact?: boolean }) {
  const t = e.allDay ? "All day" : e.start.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return (
    <Link href={e.href} title={`${TAG[e.source]} · ${e.title}${e.sub ? ` · ${e.sub}` : ""}`}
      className={`block min-w-0 rounded border-l-2 px-1.5 py-1 text-[12px] hover:bg-subtle ${e.pending ? "border-warning" : e.source === "work" || e.source === "pm" ? "border-accent" : "border-border-strong"} bg-surface`}>
      {compact ? <span className="block truncate">{e.title}</span> : <>
        <span className="block truncate text-[11px] text-faint">{t} · {TAG[e.source]}</span>
        <span className="block truncate font-medium">{e.title}</span>
        {e.sub ? <span className="block truncate text-[11px] text-faint">{e.sub}</span> : null}
      </>}
    </Link>
  );
}

export default async function CalendarPage({ params, searchParams }: PageProps<"/o/[orgSlug]/calendar">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const allowed = availableSources(principal);
  if (!allowed.length) notFound();
  const tz = principal.orgTimezone ?? "America/Vancouver";
  const view: View = (VIEWS as readonly string[]).includes(sp(q.view) ?? "") ? (sp(q.view) as View) : "week";
  const today = zonedParts(new Date(), tz).date;
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(sp(q.date) ?? "") ? sp(q.date)! : today;
  const selected = (Array.isArray(q.src) ? q.src : q.src ? [q.src] : []).filter((s): s is CalSource => allowed.includes(s as CalSource));
  const propertyId = sp(q.property);

  // the visible date range for the view, as local dates in the org time zone
  const dow = (d: string) => (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7;
  let first: string; let days: number;
  if (view === "day") { first = anchor; days = 1; }
  else if (view === "week") { first = addDays(anchor, -dow(anchor)); days = 7; }
  else if (view === "agenda") { first = anchor; days = 14; }
  else { const m1 = `${anchor.slice(0, 7)}-01`; first = addDays(m1, -dow(m1)); days = 42; }
  const dates = Array.from({ length: days }, (_, i) => addDays(first, i));
  const from = zonedToUtc(`${first}T00:00`, tz);
  const to = zonedToUtc(`${addDays(first, days)}T00:00`, tz);
  const [events, props] = await Promise.all([calendarEvents(ctx, { from, to, sources: selected, propertyId }), listPropertyOptions(ctx)]);
  // events grouped by local start date (multi-day items also appear on the days they cover)
  const byDay = new Map<string, CalEvent[]>(dates.map((d) => [d, []]));
  for (const e of events) {
    const startDay = e.allDay ? e.start.toISOString().slice(0, 10) : zonedParts(e.start, tz).date;
    const endDay = e.end && !e.allDay ? zonedParts(new Date(e.end.getTime() - 1), tz).date : startDay;
    for (let d = startDay < first ? first : startDay; d <= endDay && byDay.has(d); d = addDays(d, 1)) byDay.get(d)!.push(e);
  }

  const step = view === "month" ? null : view === "day" ? 1 : view === "week" ? 7 : 14;
  const prev = step ? addDays(anchor, -step) : (() => { const [y, m] = anchor.split("-").map(Number); return `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}-01`; })();
  const next = step ? addDays(anchor, step) : (() => { const [y, m] = anchor.split("-").map(Number); return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`; })();
  const href = (o: { view?: View; date?: string }) => {
    const s = new URLSearchParams({ view: o.view ?? view, date: o.date ?? anchor });
    for (const x of selected) s.append("src", x);
    if (propertyId) s.set("property", propertyId);
    return `/o/${orgSlug}/calendar?${s}`;
  };
  const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { timeZone: "UTC", ...o });
  const title = view === "month" ? fmt(anchor, { month: "long", year: "numeric" }) : view === "day" ? fmt(anchor, { weekday: "long", month: "long", day: "numeric" })
    : `${fmt(first, { month: "short", day: "numeric" })} – ${fmt(addDays(first, days - 1), { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <>
      <PageHeader title="Calendar" description="Scheduled work, inspections, maintenance, bookings, visitors and shifts you can see." />
      <Panel className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Link className="rounded-[var(--radius-md)] border border-border-strong px-2 py-1 text-[13px] hover:bg-subtle" href={href({ date: prev })} aria-label="Previous">←</Link>
            <Link className="rounded-[var(--radius-md)] border border-border-strong px-2 py-1 text-[13px] hover:bg-subtle" href={href({ date: today })}>Today</Link>
            <Link className="rounded-[var(--radius-md)] border border-border-strong px-2 py-1 text-[13px] hover:bg-subtle" href={href({ date: next })} aria-label="Next">→</Link>
            <h2 className="ml-2 text-sm font-semibold">{title}</h2>
          </div>
          <nav aria-label="Calendar view" className="flex gap-1 text-[13px]">
            {VIEWS.map((v) => <Link key={v} href={href({ view: v })} aria-current={v === view ? "page" : undefined} className={`rounded-full px-2.5 py-1 capitalize ${v === view ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-subtle"}`}>{v}</Link>)}
          </nav>
        </div>
        <form className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-[13px]" action={`/o/${orgSlug}/calendar`}>
          <input type="hidden" name="view" value={view} /><input type="hidden" name="date" value={anchor} />
          <fieldset className="flex flex-wrap gap-x-3 gap-y-1"><legend className="sr-only">Show</legend>
            {allowed.map((s) => <label key={s} className="flex items-center gap-1.5"><input type="checkbox" name="src" value={s} defaultChecked={!selected.length || selected.includes(s)} className="size-3.5 accent-[var(--color-accent)]" />{CAL_SOURCE_LABEL[s]}</label>)}
          </fieldset>
          {props.length > 1 ? (
            <label className="flex items-center gap-1.5"><span className="text-muted">Property</span>
              <select name="property" defaultValue={propertyId ?? ""} className="h-7 rounded-[var(--radius-md)] border border-border-strong bg-surface px-1.5"><option value="">All</option>{props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </label>
          ) : null}
          <button className="h-7 rounded-[var(--radius-md)] border border-border-strong px-2 hover:bg-subtle">Apply</button>
        </form>
      </Panel>

      {view === "month" ? (
        <Panel className="overflow-x-auto">
          <div className="grid min-w-[700px] grid-cols-7">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="border-b border-border px-2 py-1.5 text-[12px] font-medium text-muted">{d}</div>)}
            {dates.map((d) => {
              const list = byDay.get(d)!;
              const inMonth = d.slice(0, 7) === anchor.slice(0, 7);
              return (
                <div key={d} className={`min-h-28 border-b border-l border-border p-1.5 first:border-l-0 ${inMonth ? "" : "bg-subtle/40"}`}>
                  <Link href={href({ view: "day", date: d })} className={`mb-1 inline-block rounded px-1 text-[12px] ${d === today ? "bg-accent font-semibold text-accent-fg" : inMonth ? "text-fg" : "text-faint"}`}>{Number(d.slice(8))}</Link>
                  <div className="space-y-1">{list.slice(0, 3).map((e) => <Chip key={`${e.source}-${e.id}`} e={e} tz={tz} compact />)}</div>
                  {list.length > 3 ? <Link href={href({ view: "day", date: d })} className="mt-1 block text-[11px] text-accent hover:underline">+{list.length - 3} more</Link> : null}
                </div>
              );
            })}
          </div>
        </Panel>
      ) : view === "week" ? (
        <Panel className="overflow-x-auto">
          <div className="grid min-w-[840px] grid-cols-7">
            {dates.map((d) => (
              <div key={d} className="min-h-64 border-l border-border first:border-l-0">
                <Link href={href({ view: "day", date: d })} className={`block border-b border-border px-2 py-1.5 text-[12px] font-medium ${d === today ? "text-accent" : "text-muted"}`}>{fmt(d, { weekday: "short", day: "numeric" })}</Link>
                <div className="space-y-1 p-1.5">{byDay.get(d)!.map((e) => <Chip key={`${e.source}-${e.id}`} e={e} tz={tz} />)}</div>
              </div>
            ))}
          </div>
        </Panel>
      ) : (
        <Panel>
          {events.length === 0 ? <EmptyState title="Nothing scheduled" /> : (
            <ol className="divide-y divide-border">
              {dates.filter((d) => byDay.get(d)!.length).map((d) => (
                <li key={d} className="px-4 py-3">
                  <h3 className={`mb-2 text-[13px] font-semibold ${d === today ? "text-accent" : ""}`}>{fmt(d, { weekday: "long", month: "long", day: "numeric" })}</h3>
                  <ul className="space-y-1.5">{byDay.get(d)!.map((e) => (
                    <li key={`${e.source}-${e.id}`} className="grid grid-cols-[90px_minmax(0,1fr)] gap-3 text-sm">
                      <span className="text-[13px] tabular-nums text-muted">{e.allDay ? "All day" : e.start.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" })}</span>
                      <span className="min-w-0"><Link href={e.href} className="font-medium hover:underline">{e.title}</Link> <span className="text-[12px] text-faint">· {TAG[e.source]}{e.pending ? " (awaiting approval)" : ""}{e.sub ? ` · ${e.sub}` : ""}</span></span>
                    </li>
                  ))}</ul>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      )}
      <p className="mt-3 text-xs text-faint">Times in {tz.replace("_", " ")}. Calendar sync with Google and Outlook is planned.</p>
    </>
  );
}
