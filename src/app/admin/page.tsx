import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { adminFlags, adminPlatformOverview } from "@/server/billing/admin";
import { SimpleShell } from "@/components/shell/simple-shell";
import { Badge, PageHeader, Panel, PanelHeader, Stat, Table, Td, Th } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { FlagControl } from "@/components/billing/admin-bits";
import { FLAGS, FLAG_KEYS, envFlag } from "@/config/flags";
import { LIMITS, PLANS, isPlanKey, type LimitKey } from "@/config/plans";
import { formatMoney } from "@/lib/billing";
import { setFlagAction, setOrgStatusAction, verifyAllAuditAction } from "./actions";
import { SchemaForm } from "@/components/ui/schema-form";

export const metadata = { title: "Platform admin" };

const SUB_TONE: Record<string, "success" | "accent" | "warning" | "danger" | "neutral"> = { active: "success", trialing: "accent", past_due: "warning", cancelled: "danger", expired: "danger" };
const SUB_LABEL: Record<string, string> = { active: "Active", trialing: "Trial", past_due: "Past due", cancelled: "Cancelled", expired: "Trial ended" };

// platform super-admin console; invisible (404) to everyone else, including org admins
export default async function AdminPage() {
  const s = await requireSession();
  if (!s.user.isPlatformAdmin) notFound();
  const [{ rows, metrics: m }, flags] = await Promise.all([adminPlatformOverview(s.user.id), adminFlags(s.user.id)]);
  const fmt = (d: Date | null | undefined) => (d ? d.toLocaleDateString("en-CA", { dateStyle: "medium" }) : "—");
  return (
    <SimpleShell user={s.user} wide>
      <PageHeader title="Platform admin" description="Organizations, subscriptions and feature flags on this deployment." />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Organizations" value={m.orgs} sub={`${m.active} paying · ${m.trialing} on trial`} />
        <Stat label="Recurring revenue (est.)" value={formatMoney(m.mrrCents)} sub="Per month, from plan prices and unit counts" />
        <Stat label="Trials ending in 7 days" value={m.trialsEndingSoon} sub={`${m.pastDue} past due · ${m.lapsed} lapsed`} />
        <Stat label="Units managed" value={m.units.toLocaleString("en-CA")} />
        <Stat label="Assistant requests (30 days)" value={m.aiRequests30d.toLocaleString("en-CA")} />
        <Stat label="API requests (30 days)" value={m.apiRequests30d.toLocaleString("en-CA")} />
        <Stat label="Webhook failures (24h)" value={m.webhookFailures24h.toLocaleString("en-CA")} />
        <Stat label="Billing events failed" value={m.failedBillingEvents} sub={m.failedBillingEvents ? "Check the logs; the provider will retry" : "None"} />
      </div>
      <Panel>
        <PanelHeader title="Organizations" />
        <Table>
          <thead><tr><Th>Organization</Th><Th>Plan</Th><Th>Subscription</Th><Th className="text-right">Members</Th><Th className="text-right">Units</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
          <tbody>
            {rows.map((o) => {
              const sub = o.subscription;
              return (
                <tr key={o.id}>
                  <Td><Link className="font-medium text-accent hover:underline" href={`/admin/orgs/${o.id}`}>{o.name}</Link><div className="font-mono text-xs text-faint">{o.slug}</div></Td>
                  <Td>{sub && isPlanKey(sub.planKey) ? PLANS[sub.planKey].name : "—"}{sub?.provider ? <div className="text-xs text-faint">{sub.provider === "none" ? "trial" : sub.provider}</div> : null}</Td>
                  <Td>{sub ? <Badge tone={SUB_TONE[sub.status] ?? "neutral"}>{SUB_LABEL[sub.status] ?? sub.status}</Badge> : <Badge tone="danger">None</Badge>}
                    <div className="text-xs text-faint">{sub?.status === "trialing" ? `ends ${fmt(sub.trialEndsAt)}` : sub?.currentPeriodEnd ? `${sub.cancelAtPeriodEnd ? "ends" : "renews"} ${fmt(sub.currentPeriodEnd)}` : ""}</div></Td>
                  <Td className="text-right tabular-nums">{o.memberCount}</Td>
                  <Td className="text-right tabular-nums">{o.unitCount}</Td>
                  <Td>{o.status === "active" ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Suspended</Badge>}</Td>
                  <Td className="text-right">
                    <form action={setOrgStatusAction}>
                      <input type="hidden" name="orgId" value={o.id} />
                      <input type="hidden" name="status" value={o.status === "active" ? "suspended" : "active"} />
                      <Button type="submit" size="sm" variant={o.status === "active" ? "danger" : "secondary"}>{o.status === "active" ? "Suspend" : "Reactivate"}</Button>
                    </form>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Panel>
      <Panel className="mt-6" data-testid="platform-audit">
        <PanelHeader title="Audit log integrity" description="Recomputes every organization's audit hash chain (and the platform's own)." />
        <div className="p-4"><SchemaForm action={verifyAllAuditAction} submitLabel="Verify all audit logs" pendingLabel="Verifying…" fields={[]} /></div>
      </Panel>
      <Panel className="mt-6">
        <PanelHeader title="Feature flags (all organizations)" description={`Overrides here apply everywhere unless an organization has its own (${flags.orgOverrides} organization override${flags.orgOverrides === 1 ? "" : "s"}). “Default” follows the environment (FLAG_<NAME>) or the built-in default.`} />
        <ul className="divide-y divide-border">
          {FLAG_KEYS.map((k) => (
            <li key={k} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div><div className="text-sm font-medium">{FLAGS[k].label} <code className="ml-1 font-mono text-[11px] text-faint">{k}</code></div><div className="text-[13px] text-muted">{FLAGS[k].description}</div></div>
              <FlagControl action={setFlagAction.bind(null, null)} flagKey={k} label={FLAGS[k].label} current={flags.global[k]} inherited={envFlag(k)} />
            </li>
          ))}
        </ul>
      </Panel>
      <Panel className="mt-6">
        <PanelHeader title="Plans" description="Defined in src/config/plans.ts (prices in CAD). Give one organization a custom deal with limit overrides on its page." />
        <Table>
          <thead><tr><Th>Plan</Th><Th className="text-right">Base / month</Th><Th className="text-right">Included units</Th><Th className="text-right">Per extra unit</Th><Th>Limits</Th></tr></thead>
          <tbody>{Object.values(PLANS).map((p) => (
            <tr key={p.key}><Td className="font-medium">{p.name}</Td><Td className="text-right tabular-nums">{formatMoney(p.baseMonthlyCents)}</Td><Td className="text-right tabular-nums">{p.includedUnits.toLocaleString("en-CA")}</Td>
              <Td className="text-right tabular-nums">{formatMoney(p.perUnitMonthlyCents)}</Td>
              <Td className="text-[13px] text-muted">{(Object.keys(p.limits) as LimitKey[]).map((k) => `${LIMITS[k].label}: ${p.limits[k] === null ? "unlimited" : p.limits[k]!.toLocaleString("en-CA")}`).join(" · ")}</Td></tr>
          ))}</tbody>
        </Table>
      </Panel>
    </SimpleShell>
  );
}
