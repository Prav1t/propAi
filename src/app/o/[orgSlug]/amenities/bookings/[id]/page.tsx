import Link from "next/link";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { getBooking } from "@/server/modules/amenities/service";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { BOOKING_STATUS, DEPOSIT_STATUS, FEE_STATUS, money } from "@/lib/community-labels";
import { fmtDateTime } from "@/lib/time";
import { bookingDamageAction, bookingPaymentAction, cancelBookingAction, decideBookingAction } from "../../../community-actions";

export const metadata = { title: "Booking" };

export default async function BookingPage({ params, searchParams }: PageProps<"/o/[orgSlug]/amenities/bookings/[id]">) {
  const { orgSlug, id } = await params;
  const q = await searchParams;
  const { ctx } = await getOrgContext(orgSlug);
  const d = await orNotFound(getBooking(ctx, id));
  const b = d.booking, a = d.amenity, tz = d.tz;
  const base = `/o/${orgSlug}`;
  const day = b.startsAt.toLocaleDateString("en-CA", { timeZone: tz, weekday: "long", month: "long", day: "numeric" });
  const time = `${b.startsAt.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" })} – ${b.endsAt.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" })}`;
  const past = b.endsAt <= new Date();
  return (
    <>
      <Breadcrumbs items={[{ label: d.access.manage ? "Bookings" : "My bookings", href: `${base}/amenities/bookings` }, { label: `#${b.number}` }]} />
      <PageHeader title={`${a.name} · ${day}`} description={`${time} · Booking #${b.number}`} actions={<Badge tone={BOOKING_STATUS[b.status]?.tone}>{past && b.status === "approved" ? "Completed" : BOOKING_STATUS[b.status]?.label}</Badge>} />
      {sp(q.created) ? (
        <div role="status" className={`mb-4 rounded-[var(--radius-md)] border px-4 py-3 text-sm ${b.status === "approved" ? "border-success/30 bg-success-soft text-success" : "border-warning/30 bg-warning-soft text-warning"}`}>
          {b.status === "approved" ? "You're booked. " : "Request sent — management will review it and you'll be notified. "}
          {b.feeCents || b.depositCents ? `${[b.feeCents ? `Fee ${money(b.feeCents)}` : null, b.depositCents ? `refundable deposit ${money(b.depositCents)}` : null].filter(Boolean).join(" and ")} payable to management.` : null}
        </div>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title="Details" />
            <DetailList items={[
              ["Amenity", <Link key="a" className="text-accent hover:underline" href={`${base}/amenities/${a.id}?date=${b.startsAt.toLocaleDateString("en-CA", { timeZone: tz })}`}>{a.name}</Link>],
              ["When", `${day}, ${time}`], ["People", String(b.guests)], ["Purpose", b.purpose],
              ["Unit", d.unitNumber ? `Unit ${d.unitNumber}` : "Staff / building booking"], ["Booked by", d.bookedByName],
              ["Requested", fmtDateTime(b.createdAt, tz)],
              ["Decision", b.decidedAt && b.status !== "cancelled" ? `${BOOKING_STATUS[b.status]?.label}${d.decidedByName ? ` by ${d.decidedByName}` : ""} · ${fmtDateTime(b.decidedAt, tz)}` : null],
              ["Note from management", b.decisionNote], ["Cancelled", b.cancelledAt ? `${fmtDateTime(b.cancelledAt, tz)}${b.cancelReason ? ` — ${b.cancelReason}` : ""}` : null],
              ["Fee", b.feeCents ? `${money(b.feeCents)} · ${FEE_STATUS[b.feeStatus]}` : null], ["Deposit", b.depositCents ? `${money(b.depositCents)} · ${DEPOSIT_STATUS[b.depositStatus]}` : null],
              ...(d.access.manage ? [["Damage", b.damageNotes ? <span key="d">{b.damageNotes}{b.damageWorkOrderId ? <> · <Link className="text-accent hover:underline" href={`${base}/maintenance/${b.damageWorkOrderId}`}>repair work order</Link></> : null}</span> : null] as [string, React.ReactNode]] : []),
            ]} />
          </Panel>
          {a.rules ? <Panel><PanelHeader title="House rules" /><p className="whitespace-pre-line px-4 py-3 text-[13px] text-muted">{a.rules}</p></Panel> : null}
        </div>
        <div className="space-y-6">
          {d.canDecide ? (
            <Panel>
              <PanelHeader title="Review request" />
              <div className="p-4">
                <SchemaForm action={decideBookingAction.bind(null, orgSlug, id)} submitLabel="Save decision" fields={[
                  { name: "decision", label: "Decision", type: "select", options: [{ value: "approve", label: "Approve" }, { value: "decline", label: "Decline" }] },
                  { name: "note", label: "Note to the resident", type: "textarea", rows: 2, hint: "Required when declining." },
                ]} />
              </div>
            </Panel>
          ) : null}
          {d.access.manage && (b.feeCents || b.depositCents) && b.status !== "declined" ? (
            <Panel>
              <PanelHeader title="Fee & deposit" description="Recorded manually until online payments are connected." />
              <div className="p-4">
                <SchemaForm action={bookingPaymentAction.bind(null, orgSlug, id)} submitLabel="Save" hidden={{ ...(b.feeCents ? {} : { feeStatus: "none" }), ...(b.depositCents ? {} : { depositStatus: "none" }) }} fields={[
                  ...(b.feeCents ? [{ name: "feeStatus", label: `Fee (${money(b.feeCents)})`, type: "select" as const, defaultValue: b.feeStatus, options: ["due", "paid", "waived"].map((x) => ({ value: x, label: FEE_STATUS[x] })) }] : []),
                  ...(b.depositCents ? [{ name: "depositStatus", label: `Deposit (${money(b.depositCents)})`, type: "select" as const, defaultValue: b.depositStatus, options: ["due", "held", "refunded", "withheld"].map((x) => ({ value: x, label: DEPOSIT_STATUS[x] })) }] : []),
                ]} />
              </div>
            </Panel>
          ) : null}
          {d.access.manage && b.status === "approved" && b.startsAt <= new Date() ? (
            <Panel>
              <details>
                <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium">Report damage</summary>
                <div className="border-t border-border p-4">
                  <SchemaForm action={bookingDamageAction.bind(null, orgSlug, id)} submitLabel="Record damage" fields={[
                    { name: "notes", label: "What was damaged?", type: "textarea", defaultValue: b.damageNotes ?? "" },
                    { name: "createWorkOrder", label: "Open a repair work order", type: "checkbox", defaultValue: !b.damageWorkOrderId },
                    ...(b.depositCents ? [{ name: "withholdDeposit", label: "Withhold the deposit", type: "checkbox" as const }] : []),
                  ]} />
                </div>
              </details>
            </Panel>
          ) : null}
          {d.canCancel ? (
            <Panel>
              <PanelHeader title="Cancel" description={d.access.manage && !d.access.own ? "The resident will be notified with your reason." : `You can cancel up to ${a.cancellationHours} hours before the start.`} />
              <div className="p-4">
                {d.access.manage && !d.access.own ? (
                  <SchemaForm action={cancelBookingAction.bind(null, orgSlug, id)} submitLabel="Cancel booking" fields={[{ name: "reason", label: "Reason", type: "textarea", rows: 2 }]} />
                ) : <ConfirmAction action={cancelBookingAction.bind(null, orgSlug, id)} label="Cancel booking…" confirmLabel="Yes, cancel it" description="This frees the time for others." />}
              </div>
            </Panel>
          ) : d.cancelCutoffPassed ? <Panel className="p-4 text-[13px] text-muted">It&apos;s too close to the start to cancel online. Please contact management.</Panel> : null}
        </div>
      </div>
    </>
  );
}
