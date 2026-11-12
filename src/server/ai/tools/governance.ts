import "server-only";
import { z } from "zod";
import { listMeetings, listOpenMotions } from "../../modules/meetings/service";
import { listLeases } from "../../modules/leases/service";
import { MEETING_KIND, MEETING_STATUS } from "@/lib/governance";
import { LEASE_STATUS, money } from "@/lib/leasing";
import { anyPerm, defineTool, ok, plural } from "./registry";
import { fmtDay, fmtWhen, lim, limitArg, locationArg, placeFilter, where } from "./common";
import { isErr } from "./resolve";

// Read tools for governance and leasing (Iteration 13). Like every tool they run the same services as the screens,
// so a person sees only the meetings and leases of the properties their role covers.

export const searchMeetings = defineTool({
  name: "search_meetings",
  title: "Checking meetings and motions",
  description: "Council and general meetings with their motions. Views: 'upcoming' (scheduled), 'past' (held or cancelled), 'open_motions' (motions still open for voting).",
  input: z.object({ view: z.enum(["upcoming", "past", "open_motions"]).optional().describe("Default 'upcoming'."), location: locationArg, limit: limitArg }),
  available: anyPerm("meeting.read", "meeting.manage"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    if (a.view === "open_motions") {
      const rows = (await listOpenMotions(ctx)).slice(0, lim(a.limit));
      const items = rows.map((m) => ({ id: m.id, motion: m.number, text: m.text, meeting: m.meetingTitle, property: m.propertyName, href: env.href(`/meetings/${m.meetingId}#motion-${m.number}`) }));
      return {
        result: ok(items.length ? `${plural(items.length, "motion is", "motions are")} open for voting.` : "No motions are open for voting.", {
          count: items.length, items, highlights: items.map((m) => `[Motion ${m.motion}](${m.href}) at ${m.meeting}: ${m.text}`),
        }),
        display: { records: items.map((m) => ({ ref: `Motion ${m.motion}`, title: m.text.length > 90 ? `${m.text.slice(0, 90)}…` : m.text, href: m.href, sub: `${m.meeting} · ${m.property}`, badges: [{ label: "Open for voting", tone: "accent" as const }] })) },
      };
    }
    const view = a.view ?? "upcoming";
    const page = await listMeetings(ctx, { view, propertyId: pf.propertyId });
    const items = page.rows.slice(0, lim(a.limit)).map((m) => ({
      id: m.id, title: m.title, kind: MEETING_KIND[m.kind] ?? m.kind, status: m.status, when: fmtWhen(m.scheduledAt, env), property: m.propertyName, location: m.location,
      motions: m.motions, openMotions: m.openMotions, minutesApproved: m.minutesApproved, href: env.href(`/meetings/${m.id}`),
    }));
    const noun = view === "upcoming" ? ["meeting is scheduled", "meetings are scheduled"] : ["past meeting", "past meetings"];
    return {
      result: ok(page.total ? `${plural(page.total, noun[0], noun[1])}${where(pf.place)}.` : `No ${view === "upcoming" ? "meetings are scheduled" : "past meetings"}${where(pf.place)}.`, {
        count: page.total, items,
        highlights: items.map((m) => `[${m.title}](${m.href}) — ${m.when}, ${m.property}${m.motions ? `; ${m.motions} motion${m.motions === 1 ? "" : "s"}${m.openMotions ? ` (${m.openMotions} open)` : ""}` : ""}${m.minutesApproved ? "; minutes approved" : ""}`),
      }),
      display: { records: items.map((m) => ({ ref: m.kind, title: m.title, href: m.href, sub: [m.when, m.property, m.location].filter(Boolean).join(" · "),
        badges: [{ label: MEETING_STATUS[m.status]?.label ?? m.status, tone: MEETING_STATUS[m.status]?.tone ?? "neutral" }, ...(m.openMotions ? [{ label: `${m.openMotions} open motion${m.openMotions === 1 ? "" : "s"}`, tone: "accent" as const }] : [])] })) },
    };
  },
});

export const searchLeases = defineTool({
  name: "search_leases",
  title: "Checking leases and rent",
  description: "Leases with their rent position, from recorded charges and payments. Views: 'current' (in force), 'overdue' (rent past its due date), 'ending' (ending or moving out within 60 days), 'ended'. Includes totals: leases in force, monthly rent roll, rent overdue.",
  input: z.object({ view: z.enum(["current", "overdue", "ending", "ended"]).optional().describe("Default 'current'."), location: locationArg, limit: limitArg }),
  available: anyPerm("lease.read", "lease.manage"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const view = a.view ?? "current";
    const page = await listLeases(ctx, { view, propertyId: pf.propertyId });
    const s = page.summary;
    const items = page.rows.slice(0, lim(a.limit)).map((l) => ({
      id: l.id, unit: l.unitNumber, tenant: l.tenantName, property: l.propertyName, rent: money(l.rentCents), overdue: l.overdueCents ? money(l.overdueCents) : null,
      starts: fmtDay(l.startsOn, env), ends: l.moveOutOn ? `moving out ${fmtDay(l.moveOutOn, env)}` : l.endsOn ? fmtDay(l.endsOn, env) : "month to month", status: l.upcoming ? "upcoming" : l.status, href: env.href(`/leases/${l.id}`),
    }));
    const summary = { leasesInForce: s.inForce, monthlyRentRoll: money(s.rentRollCents), rentOverdue: money(s.overdueCents), leasesWithOverdueRent: s.overdueLeases, endingWithin60Days: s.endingSoon };
    const lead = view === "overdue" ? (page.total ? `${money(s.overdueCents)} of rent is past its due date across ${plural(page.total, "lease", "leases")}${where(pf.place)}.` : `No rent is overdue${where(pf.place)}.`)
      : view === "ending" ? (page.total ? `${plural(page.total, "lease ends", "leases end")} within 60 days${where(pf.place)}.` : `No leases end within 60 days${where(pf.place)}.`)
      : view === "ended" ? `${plural(page.total, "ended lease", "ended leases")}${where(pf.place)}.`
      : `${plural(s.inForce, "lease", "leases")} in force${where(pf.place)}, with a monthly rent roll of ${money(s.rentRollCents)}${s.overdueCents ? `; ${money(s.overdueCents)} is overdue` : ""}.`;
    return {
      result: ok(lead, {
        count: page.total, facts: summary, items,
        highlights: items.map((l) => `[Unit ${l.unit}, ${l.tenant}](${l.href}) — ${l.rent} a month${l.overdue ? `, ${l.overdue} overdue` : ""}${view === "ending" || l.status === "notice" ? `, ${l.ends}` : ""}`),
      }),
      display: {
        metrics: [{ label: "Leases in force", value: String(s.inForce) }, { label: "Monthly rent roll", value: money(s.rentRollCents) }, { label: "Rent overdue", value: money(s.overdueCents), tone: s.overdueCents ? "danger" as const : undefined }],
        records: items.map((l) => ({ ref: `Unit ${l.unit}`, title: l.tenant, href: l.href, sub: [l.property, `${l.rent} a month`, l.ends].join(" · "),
          badges: [{ label: LEASE_STATUS[l.status]?.label ?? l.status, tone: LEASE_STATUS[l.status]?.tone ?? "neutral" }, ...(l.overdue ? [{ label: `${l.overdue} overdue`, tone: "danger" as const }] : [])] })),
        more: { label: "Open leases", href: env.href(`/leases?view=${view}`) },
      },
    };
  },
});
