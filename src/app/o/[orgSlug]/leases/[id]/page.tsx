import Link from "next/link";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getLease } from "@/server/modules/leases/service";
import { Badge, PageHeader, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { CHARGE_STATE, LEASE_STATUS, chargeState, money, monthLabel } from "@/lib/leasing";
import { fmtDay } from "@/lib/time";
import { changeTermsAction, endLeaseAction, giveNoticeAction, recordPaymentAction, withdrawNoticeAction } from "../../governance-actions";

export const metadata = { title: "Lease" };

export default async function LeasePage({ params }: PageProps<"/o/[orgSlug]/leases/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx } = await getOrgContext(orgSlug);
  const d = await orNotFound(getLease(ctx, id));
  const l = d.lease;
  const base = `/o/${orgSlug}`;
  const status = d.upcoming ? "upcoming" : l.status;
  const inForce = l.status !== "ended";
  const tenantName = `${d.tenant.firstName} ${d.tenant.lastName}`;
  return (
    <>
      <Breadcrumbs items={[{ label: "Leases", href: `${base}/leases` }, { label: `Unit ${d.unitNumber}` }]} />
      <PageHeader title={`Unit ${d.unitNumber}, ${tenantName}`} description={d.buildingName === d.propertyName ? d.propertyName : `${d.propertyName}, ${d.buildingName}`} actions={<Badge tone={LEASE_STATUS[status]?.tone}>{LEASE_STATUS[status]?.label}</Badge>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title="Rent" description={d.charges.length ? `${money(d.owingCents)} owing in total${d.overdueCents ? `, ${money(d.overdueCents)} of it past its due date` : ""}.` : d.upcoming ? "The first month is charged when the lease starts." : "No months charged yet."} />
            {d.charges.length ? (
              <Table cards>
                <thead><tr><Th>Month</Th><Th>Due</Th><Th>Charged</Th><Th>Received</Th><Th>Status</Th>{d.access.manage ? <Th><span className="sr-only">Record a payment</span></Th> : null}</tr></thead>
                <tbody>
                  {d.charges.map((c) => {
                    const st = chargeState(c, d.today);
                    const left = c.amountCents - c.paidCents;
                    return (
                      <tr key={c.id} data-testid="rent-row">
                        <Td className="font-medium">{monthLabel(c.period)}{c.note ? <div className="text-xs font-normal text-faint">{c.note}</div> : null}</Td>
                        <Td label="Due" className="text-[13px] text-muted">{fmtDay(c.dueOn)}</Td>
                        <Td label="Charged" className="tabular-nums">{money(c.amountCents)}</Td>
                        <Td label="Received" className="tabular-nums">{money(c.paidCents)}{c.paidOn ? <span className="text-xs text-faint"> on {fmtDay(c.paidOn)}</span> : null}</Td>
                        <Td label="Status"><Badge tone={CHARGE_STATE[st].tone}>{CHARGE_STATE[st].label}</Badge></Td>
                        {d.access.manage ? (
                          <Td>
                            {left > 0 ? (
                              <details>
                                <summary className="cursor-pointer text-[13px] font-medium text-accent">Record payment<span className="sr-only"> for {monthLabel(c.period)}</span></summary>
                                <div className="mt-2 min-w-56">
                                  <SchemaForm action={recordPaymentAction.bind(null, orgSlug, c.id)} submitLabel="Record" fields={[
                                    { name: "amount", label: "Amount received ($)", defaultValue: (left / 100).toFixed(2) },
                                    { name: "paidOn", label: "Received on", type: "date", defaultValue: d.today },
                                    { name: "note", label: "Note (optional)", placeholder: "e-transfer, cheque 104…" },
                                  ]} />
                                </div>
                              </details>
                            ) : null}
                          </Td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            ) : null}
          </Panel>
          {l.notes ? <Panel><PanelHeader title="Notes" /><p className="whitespace-pre-line px-4 py-3 text-sm">{l.notes}</p></Panel> : null}
        </div>
        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Terms" />
            <DetailList items={[
              ["Tenant", d.access.canSeeResident ? <Link key="t" className="text-accent hover:underline" href={`${base}/residents/${d.tenant.id}`}>{tenantName}</Link> : tenantName],
              ["Starts", fmtDay(l.startsOn)], ["Ends", l.endsOn ? fmtDay(l.endsOn) : "Month to month"],
              ["Monthly rent", money(l.rentCents)], ["Rent due", `Day ${l.dueDay} of each month`], ["Deposit held", l.depositCents ? money(l.depositCents) : null],
              ["Notice given", l.noticeGivenOn ? fmtDay(l.noticeGivenOn) : null], [l.status === "ended" ? "Moved out" : "Moving out", l.moveOutOn ? fmtDay(l.moveOutOn) : null],
            ]} />
          </Panel>
          {d.access.manage && inForce ? (
            <>
              <Panel>
                <PanelHeader title="Renew or change the rent" description="Applies to months not yet charged." />
                <div className="p-4">
                  <SchemaForm action={changeTermsAction.bind(null, orgSlug, id)} submitLabel="Save terms" fields={[
                    { name: "rent", label: "Monthly rent ($)", defaultValue: (l.rentCents / 100).toFixed(2) },
                    { name: "endsOn", label: "Ends (empty for month to month)", type: "date", defaultValue: l.endsOn ?? "" },
                    { name: "notes", label: "Notes", type: "textarea", defaultValue: l.notes ?? "" },
                  ]} />
                </div>
              </Panel>
              <Panel>
                <PanelHeader title="Moving out" />
                <div className="space-y-3 p-4">
                  <SchemaForm action={giveNoticeAction.bind(null, orgSlug, id)} submitLabel={l.status === "notice" ? "Change the move-out date" : "Record notice"} fields={[{ name: "moveOutOn", label: "Move-out date", type: "date", defaultValue: l.moveOutOn ?? "" }]} />
                  {l.status === "notice" ? <ConfirmAction action={withdrawNoticeAction.bind(null, orgSlug, id)} label="Withdraw the notice" confirmLabel="Withdraw notice" variant="secondary" description="The lease goes back to active with no move-out date." /> : null}
                  <ConfirmAction action={endLeaseAction.bind(null, orgSlug, id)} label="End the lease now" confirmLabel="End lease" hidden={{ endedOn: l.moveOutOn && l.moveOutOn <= d.today ? l.moveOutOn : d.today }} description="The tenant has moved out. Rent stops being charged after this month; what is still owing stays on the record." />
                </div>
              </Panel>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
