import "server-only";
import { z } from "zod";
import { listVisitors, type VisitorView } from "../../modules/visitors/service";
import { listHandoffs, myShifts, onShiftNow, previewSnapshot, type Snapshot } from "../../modules/shifts/service";
import { listPropertyOptions } from "../../modules/portfolio/service";
import { SHIFT_POSITION, VISITOR_KIND, VISITOR_STATUS } from "@/lib/facility-labels";
import { anyPerm, defineTool, err, ok, plural, type ToolEnv } from "./registry";
import { fmtWhen, lim, limitArg, locationArg, placeFilter, where } from "./common";
import { isErr } from "./resolve";

const time = (d: Date, tz: string) => d.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" });

export const searchVisitors = defineTool({
  name: "search_visitors",
  title: "Checking the visitor log",
  description: "Visitors and guests (residents: their own unit's guests). Views: 'today' (expected today), 'on_site' (checked in now), 'upcoming', 'past'.",
  input: z.object({
    view: z.enum(["today", "on_site", "upcoming", "past", "all"]).optional().describe("Default 'today'."),
    q: z.string().trim().max(80).optional().describe("Visitor name, company, unit number or licence plate."),
    location: locationArg,
    limit: limitArg,
  }),
  available: anyPerm("visitor.manage", "visitor.invite"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const view = (a.view ?? "today") as VisitorView;
    const page = await listVisitors(ctx, { view, q: a.q, propertyId: pf.propertyId, buildingId: pf.buildingId, pageSize: lim(a.limit) });
    const staff = ctx.principal.role.category === "staff";
    const items = page.rows.map((v) => ({
      id: v.id, name: v.name, company: v.company, kind: v.kind, status: v.status, unit: v.unitNumber, building: v.buildingName, property: v.propertyName,
      expected: `${fmtWhen(v.expectedFrom, { ...env, timeZone: v.tz })} – ${time(v.expectedUntil, v.tz)}`, checkedIn: fmtWhen(v.checkedInAt, { ...env, timeZone: v.tz }),
      pastWindow: v.overstay, plate: staff ? v.plate : undefined, href: env.href(`/visitors/${v.id}`),
    }));
    const noun = { today: "visitor expected today", on_site: "visitor on site now", upcoming: "upcoming visitor", past: "past visitor", all: "visitor" }[view];
    const overstays = items.filter((i) => i.pastWindow).length;
    return {
      result: ok(page.total ? `${plural(page.total, noun, noun.replace("visitor", "visitors"))}${where(pf.place)}${overstays ? `; ${overstays} past their window` : ""}.` : `No ${noun.replace("visitor", "visitors")}${where(pf.place)}.`, {
        count: page.total, items,
        highlights: items.slice(0, 8).map((v) => `[${v.name}](${v.href})${v.company ? ` (${v.company})` : ""} — ${[v.unit ? `Unit ${v.unit}` : null, v.building, view === "on_site" ? `in since ${v.checkedIn}` : v.expected, v.pastWindow ? "past their window" : null].filter(Boolean).join(" · ")}`),
      }),
      display: { records: items.map((v) => ({ ref: VISITOR_KIND[v.kind] ?? v.kind, title: v.name, href: v.href, sub: [v.unit ? `Unit ${v.unit}` : null, v.building, v.expected].filter(Boolean).join(" · "),
        badges: [{ label: VISITOR_STATUS[v.status]?.label ?? v.status, tone: VISITOR_STATUS[v.status]?.tone ?? "neutral" }, ...(v.pastWindow ? [{ label: "Past window", tone: "warning" as const }] : [])] })) },
    };
  },
});

export const whosOnShift = defineTool({
  name: "whos_on_shift",
  title: "Checking who's on shift",
  description: "Staff scheduled right now (including on-call), with position, where, until when and whether they've clocked in.",
  input: z.object({ location: locationArg }),
  available: anyPerm("shift.read", "shift.manage"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const rows = (await onShiftNow(ctx, { propertyId: pf.propertyId }))
      .filter((s) => !pf.place?.buildingId || !s.buildingName || pf.place.label.startsWith(`${s.buildingName} ·`));
    const items = rows.map((s) => ({
      name: s.name, position: SHIFT_POSITION[s.position] ?? s.position, onCall: s.onCall, property: s.propertyName, building: s.buildingName,
      until: time(s.endsAt, s.tz), clockedIn: !!s.clockedInAt && !s.clockedOutAt,
    }));
    const working = items.filter((i) => !i.onCall);
    const onCall = items.filter((i) => i.onCall);
    const summary = items.length
      ? `${plural(working.length, "person", "people")} on shift${onCall.length ? ` and ${onCall.length} on call` : ""}${where(pf.place)} right now.`
      : `Nobody is scheduled${where(pf.place)} right now.`;
    return {
      result: ok(summary, {
        count: items.length, items,
        highlights: items.map((i) => `${i.name} — ${i.onCall ? "on call" : i.position} · ${[i.building, i.property].filter(Boolean).join(", ")} · until ${i.until}${!i.onCall && !i.clockedIn ? " · not clocked in" : ""}`),
      }),
      display: { records: items.map((i) => ({ ref: i.onCall ? "On call" : i.position, title: i.name, href: env.href("/shifts"), sub: `${[i.building, i.property].filter(Boolean).join(" · ")} · until ${i.until}`,
        badges: i.onCall ? [] : [i.clockedIn ? { label: "Clocked in", tone: "success" as const } : { label: "Not clocked in", tone: "warning" as const }] })) },
    };
  },
});

function snapshotLines(s: Snapshot, env: ToolEnv): string[] {
  const out: string[] = [];
  if (s.packages) out.push(`Packages waiting: ${s.packages.waiting}${s.packages.perishable ? ` (${s.packages.perishable} perishable)` : ""}${s.packages.overdue ? `, ${s.packages.overdue} over 7 days` : ""}`);
  if (s.visitors) out.push(`Visitors on site: ${s.visitors.onSite.length}${s.visitors.onSite.some((v) => v.overstay) ? ` (${s.visitors.onSite.filter((v) => v.overstay).length} past their window)` : ""}; expected in the next 4 h: ${s.visitors.expectedNext4h}`);
  if (s.tasks) out.push(`Open tasks: ${s.tasks.open}${s.tasks.items.length ? ` — e.g. ${s.tasks.items.slice(0, 3).map((t) => t.title).join("; ")}` : ""}`);
  if (s.incidents) out.push(`Incidents in the last 12 h: ${s.incidents.last12h.length}${s.incidents.last12h.length ? ` (${s.incidents.last12h.slice(0, 3).map((i) => `#${i.number} ${i.title}`).join("; ")})` : ""}; open serious: ${s.incidents.openSerious}`);
  if (s.emergencies?.length) out.push(`Open emergency work orders: ${s.emergencies.map((e) => `[WO-${e.number}](${env.href(`/maintenance?q=${e.number}&view=all`)}) ${e.title}`).join("; ")}`);
  if (s.messagesNeedingReply !== undefined) out.push(`Resident messages waiting for a reply: ${s.messagesNeedingReply}`);
  if (s.bookingsRestOfToday !== undefined) out.push(`Amenity bookings in the next 12 h: ${s.bookingsRestOfToday}`);
  if (s.parkingToReview !== undefined) out.push(`Parking reports to review: ${s.parkingToReview}`);
  return out;
}

export const shiftSummary = defineTool({
  name: "shift_summary",
  title: "Reading the last handoff",
  description: "The latest shift handoff for a property (notes from the previous shift, who wrote it, whether it was acknowledged) plus a live snapshot of open items now.",
  input: z.object({ location: locationArg }),
  available: anyPerm("shift.read", "shift.manage"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const [latest] = await listHandoffs(ctx, { propertyId: pf.propertyId, limit: 1 });
    const mine = pf.propertyId || latest ? [] : await myShifts(ctx);
    const propertyId = pf.propertyId ?? latest?.propertyId ?? mine[0]?.propertyId;
    if (!propertyId) {
      const opts = await listPropertyOptions(ctx);
      return { result: err("AMBIGUOUS", "Which property's shift do you mean?", opts.map((o) => o.name)) };
    }
    const now = await previewSnapshot(ctx, propertyId, pf.buildingId ?? null);
    const nowLines = snapshotLines(now, env);
    const facts = {
      latestHandoff: latest ? {
        property: latest.propertyName, building: latest.buildingName, writtenBy: latest.authorName, at: fmtWhen(latest.createdAt, { ...env, timeZone: latest.tz }),
        notes: latest.notes, acknowledgedBy: latest.acknowledgedByName, snapshotThen: snapshotLines(latest.snapshot, env),
      } : null,
      openItemsNow: nowLines,
    };
    const summary = latest
      ? `Last handoff at ${latest.propertyName}${latest.buildingName ? ` (${latest.buildingName})` : ""} was written by ${latest.authorName ?? "a former staff member"} at ${facts.latestHandoff!.at}${latest.acknowledgedByName ? `, read by ${latest.acknowledgedByName}` : ", not yet acknowledged"}.`
      : "No handoff has been written for this property yet.";
    const highlights = [...(latest ? [`Handoff notes: ${latest.notes}`] : []), ...nowLines.map((l) => `Now — ${l}`), `[Open shift handoffs](${env.href("/shifts/handoff")})`];
    return {
      result: ok(summary, { facts, highlights }),
      display: { metrics: [
        ...(now.packages ? [{ label: "Packages waiting", value: String(now.packages.waiting) }] : []),
        ...(now.visitors ? [{ label: "Visitors on site", value: String(now.visitors.onSite.length) }] : []),
        ...(now.tasks ? [{ label: "Open tasks", value: String(now.tasks.open) }] : []),
        ...(now.incidents ? [{ label: "Incidents (12 h)", value: String(now.incidents.last12h.length), tone: now.incidents.openSerious ? "danger" as const : undefined }] : []),
      ], more: { label: "Shift handoffs", href: env.href("/shifts/handoff") } },
    };
  },
});
