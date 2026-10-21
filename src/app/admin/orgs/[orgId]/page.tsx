import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { adminOrgDetail } from "@/server/billing/admin";
import { NotFoundError } from "@/server/authz/authorize";
import { SimpleShell } from "@/components/shell/simple-shell";
import { Badge, PageHeader, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { SchemaForm } from "@/components/ui/schema-form";
import { FlagControl } from "@/components/billing/admin-bits";
import { FLAGS, FLAG_KEYS } from "@/config/flags";
import { LIMITS, PLANS, PLAN_KEYS, type LimitKey } from "@/config/plans";
import { setFlagAction, updateSubscriptionAction } from "../../actions";

export const metadata = { title: "Organization — platform admin" };

export default async function AdminOrgPage({ params }: PageProps<"/admin/orgs/[orgId]">) {
  const s = await requireSession();
  if (!s.user.isPlatformAdmin) notFound();
  const { orgId } = await params;
  const d = await adminOrgDetail(s.user.id, orgId).catch((e) => { if (e instanceof NotFoundError) notFound(); throw e; });
  const sub = d.subscription;
  const overrides = (sub?.limitOverrides ?? {}) as Partial<Record<LimitKey, number | null>>;
  const fmt = (x: Date | null | undefined) => (x ? x.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "—");
  return (
    <SimpleShell user={s.user} wide>
      <PageHeader title={d.org.name} description={`${d.org.slug} · ${d.unitCount.toLocaleString("en-CA")} units`} actions={<Link className="text-sm text-accent underline" href="/admin">All organizations</Link>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Subscription" description={sub ? `${sub.status} · provider ${sub.provider}${sub.trialEndsAt ? ` · trial ends ${fmt(sub.trialEndsAt)}` : ""}${sub.currentPeriodEnd ? ` · period ends ${fmt(sub.currentPeriodEnd)}` : ""}` : "None"} />
          <div className="p-4">
            <SchemaForm action={updateSubscriptionAction.bind(null, orgId)} submitLabel="Save subscription" pendingLabel="Saving…" columns={2} fields={[
              { name: "planKey", label: "Plan", type: "select", options: PLAN_KEYS.map((k) => ({ value: k, label: PLANS[k].name })), defaultValue: sub?.planKey ?? "professional" },
              { name: "status", label: "Status", type: "select", options: [{ value: "", label: "Keep as is" }, { value: "active", label: "Active (managed by support)" }, { value: "trialing", label: "Trial" }], defaultValue: "" },
              { name: "extendTrialDays", label: "Extend the trial by (days)", type: "number", defaultValue: "", hint: "Restarts a trial from today if it already ended." },
              ...(Object.keys(LIMITS) as LimitKey[]).map((k) => ({ name: `limit_${k}`, label: `${LIMITS[k].label} limit`, defaultValue: k in overrides ? (overrides[k] === null ? "unlimited" : String(overrides[k])) : "",
                placeholder: `Plan default: ${PLANS[(sub?.planKey ?? "professional") as "professional"].limits[k] ?? "unlimited"}`, hint: "Blank = plan default." })),
            ]} />
            <p className="mt-3 text-[12px] text-faint">Paid subscriptions keep their provider; changing the plan here records a support-managed change. Every change is in the organization&apos;s audit log.</p>
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="Feature flags for this organization" />
          <ul className="divide-y divide-border">
            {FLAG_KEYS.map((k) => (
              <li key={k} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="text-sm"><span className="font-medium">{FLAGS[k].label}</span> {d.effectiveFlags[k] ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}</div>
                <FlagControl action={setFlagAction.bind(null, orgId)} flagKey={k} label={FLAGS[k].label} current={d.flagOverrides[k]} inherited={d.effectiveFlags[k]} />
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      <Panel className="mt-6">
        <PanelHeader title="Billing events" description="Newest first, as received from the billing provider." />
        {d.events.length ? (
          <Table>
            <thead><tr><Th>Received</Th><Th>Type</Th><Th>Event id</Th><Th>Status</Th></tr></thead>
            <tbody>{d.events.map((e) => (
              <tr key={e.id}><Td className="text-[13px]">{fmt(e.createdAt)}</Td><Td className="font-mono text-[12px]">{e.type}</Td><Td className="font-mono text-[11px] text-faint">{e.eventId}</Td>
                <Td>{e.status === "processed" ? <Badge tone="success">Processed</Badge> : e.status === "failed" ? <Badge tone="danger">Failed</Badge> : <Badge>{e.status}</Badge>}{e.error ? <div className="text-[12px] text-muted">{e.error}</div> : null}</Td></tr>
            ))}</tbody>
          </Table>
        ) : <p className="p-4 text-sm text-muted">No billing events yet.</p>}
      </Panel>
    </SimpleShell>
  );
}
