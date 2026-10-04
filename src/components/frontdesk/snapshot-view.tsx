import type { Snapshot } from "@/server/modules/shifts/service";

// the factual part of a shift handoff (what was open at the time), rendered compactly
export function SnapshotView({ s }: { s: Snapshot }) {
  const rows: [string, string][] = [];
  if (s.emergencies) rows.push(["Open emergencies", s.emergencies.length ? s.emergencies.map((w) => `#${w.number} ${w.title}`).join("; ") : "None"]);
  if (s.incidents) rows.push(["Incidents (12 h)", s.incidents.last12h.length ? s.incidents.last12h.map((i) => `#${i.number} ${i.title} (${i.severity})`).join("; ") : "None"], ...(s.incidents.openSerious ? [["Open high/critical", String(s.incidents.openSerious)] as [string, string]] : []));
  if (s.visitors) rows.push(["Visitors on site", s.visitors.onSite.length ? s.visitors.onSite.map((v) => `${v.name}${v.unit ? ` (${v.unit})` : ""}${v.overstay ? " — past window" : ""}`).join("; ") : "None"], ["Expected next 4 h", String(s.visitors.expectedNext4h)]);
  if (s.packages) rows.push(["Packages waiting", `${s.packages.waiting}${s.packages.perishable ? ` · ${s.packages.perishable} perishable` : ""}${s.packages.overdue ? ` · ${s.packages.overdue} over 7 days` : ""}`]);
  if (s.messagesNeedingReply !== undefined) rows.push(["Messages needing reply", String(s.messagesNeedingReply)]);
  if (s.bookingsRestOfToday !== undefined) rows.push(["Bookings next 12 h", String(s.bookingsRestOfToday)]);
  if (s.parkingToReview !== undefined) rows.push(["Parking reports to review", String(s.parkingToReview)]);
  if (s.tasks) rows.push(["Open tasks", s.tasks.open ? `${s.tasks.open}: ${s.tasks.items.map((t) => t.title).join("; ")}${s.tasks.open > s.tasks.items.length ? "…" : ""}` : "None"]);
  if (!rows.length) return <p className="text-[13px] text-muted">Nothing in your areas to summarise.</p>;
  return (
    <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
      {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="[overflow-wrap:anywhere]">{v}</dd></div>)}
    </dl>
  );
}
