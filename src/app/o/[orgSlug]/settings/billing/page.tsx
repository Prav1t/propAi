import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { getBillingOverview } from "@/server/billing/service";
import { Badge, PageHeader, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { FormAlert } from "@/components/ui/form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { ResultButton } from "@/components/billing/billing-bits";
import { FEATURES, LIMITS, PLANS, type Feature, type LimitKey, type PlanKey } from "@/config/plans";
import { describeViolation, formatMoney } from "@/lib/billing";
import { cn } from "@/lib/cn";
import { billingPortalAction, cancelSubscriptionAction, changePlanAction, resumeSubscriptionAction } from "./actions";

export const metadata = { title: "Billing" };

const fmtDate = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleDateString("en-CA", { dateStyle: "medium" }) : "—");
const STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "accent" | "neutral" }> = {
  trialing: { label: "Free trial", tone: "accent" }, active: { label: "Active", tone: "success" }, past_due: { label: "Payment overdue", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "danger" }, expired: { label: "Trial ended", tone: "danger" },
};
const INVOICE_TONE: Record<string, "success" | "warning" | "neutral" | "danger"> = { paid: "success", open: "warning", void: "neutral", uncollectible: "danger" };

// used vs allowed; the text carries the meaning, the bar repeats it
function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const state = limit === null ? null : used >= limit ? "At the limit" : pct >= 80 ? "Near the limit" : null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted">{used.toLocaleString("en-CA")} {limit === null ? "· unlimited" : `of ${limit.toLocaleString("en-CA")}`}</span>
      </div>
      {limit !== null ? (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-subtle" role="img" aria-label={`${label}: ${used} of ${limit} used`}>
          <div className={cn("h-full rounded-full", state === "At the limit" ? "bg-danger" : state ? "bg-warning" : "bg-accent")} style={{ width: `${Math.max(pct, used ? 2 : 0)}%` }} />
        </div>
      ) : null}
      {state ? <p className={cn("mt-1 text-[12px]", state === "At the limit" ? "text-danger" : "text-warning")}>{state}</p> : null}
    </div>
  );
}

export default async function BillingPage({ params, searchParams }: PageProps<"/o/[orgSlug]/settings/billing">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("billing.manage")) notFound();
  const o = await getBillingOverview(ctx);
  const { ent } = o;
  const sub = ent.subscription;
  const status = STATUS[sub?.status ?? "expired"] ?? STATUS.expired;
  const checkout = sp(q.checkout);
  const sum30 = (metric: string) => o.history.filter((h) => h.metric === metric).reduce((a, h) => a + h.quantity, 0);
  const latest = (metric: string) => o.history.filter((h) => h.metric === metric).at(-1)?.quantity ?? null;
  const currentKey = ent.plan.key;

  return (
    <>
      <PageHeader title="Plan and billing" description="Your plan, what you use against its limits, and your invoices." />
      {o.provider?.development ? (
        <FormAlert kind="info">Development billing: checkout, invoices and renewals are simulated and nothing is charged. Production deployments use Stripe (BILLING_PROVIDER=stripe).</FormAlert>
      ) : null}
      {checkout === "success" ? <div className="mt-3"><FormAlert kind="success">Thanks — your plan is active.{o.provider?.key === "stripe" ? " Stripe may take a few seconds to confirm; refresh if the plan below hasn't changed yet." : ""}</FormAlert></div> : null}
      {checkout === "cancelled" ? <div className="mt-3"><FormAlert kind="info">Checkout was cancelled. Nothing changed.</FormAlert></div> : null}
      {ent.readOnly ? <div className="mt-3"><FormAlert>{`Read-only: ${ent.access.reason}`}</FormAlert></div> : null}

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHeader title="Subscription" />
          <dl className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">Plan</dt><dd className="mt-0.5 flex items-center gap-2 font-medium">{ent.plan.name} <Badge tone={status.tone}>{status.label}</Badge></dd></div>
            <div><dt className="text-muted">Billed</dt><dd className="mt-0.5">{sub?.provider === "none" ? "Not yet — free trial" : sub?.provider === "manual" ? "By arrangement with support" : sub?.interval === "year" ? "Yearly" : "Monthly"}{o.provider && sub?.provider !== "none" && sub?.provider !== "manual" ? ` · ${o.provider.label}` : ""}</dd></div>
            {sub?.status === "trialing" ? <div><dt className="text-muted">Trial ends</dt><dd className="mt-0.5">{fmtDate(sub.trialEndsAt)} ({ent.access.daysLeft} day{ent.access.daysLeft === 1 ? "" : "s"} left)</dd></div> : null}
            {sub && (sub.status === "active" || sub.status === "past_due") ? <div><dt className="text-muted">{sub.cancelAtPeriodEnd ? "Ends on" : "Renews on"}</dt><dd className="mt-0.5">{fmtDate(sub.currentPeriodEnd)}</dd></div> : null}
            {sub?.pendingPlanKey ? <div className="sm:col-span-2"><dt className="text-muted">Scheduled change</dt><dd className="mt-0.5">Moves to {PLANS[sub.pendingPlanKey as PlanKey]?.name} ({sub.pendingInterval === "year" ? "yearly" : "monthly"}) on {fmtDate(sub.currentPeriodEnd)}. Choose {ent.plan.name} below to keep it.</dd></div> : null}
            {o.estimate ? <div className="sm:col-span-2"><dt className="text-muted">Next invoice (estimate at today&apos;s unit count)</dt><dd className="mt-0.5 font-medium tabular-nums">{formatMoney(o.estimate.totalCents, o.estimate.currency)}</dd></div> : null}
            {ent.access.state === "grace" ? <div className="sm:col-span-2"><FormAlert>{ent.access.reason}</FormAlert></div> : null}
          </dl>
          {o.paidSubscription && o.canSelfServe ? (
            <div className="flex flex-wrap items-start gap-3 border-t border-border p-4">
              {sub?.cancelAtPeriodEnd
                ? <ResultButton action={resumeSubscriptionAction.bind(null, orgSlug)} label="Keep my subscription" variant="primary" />
                : <ConfirmAction action={cancelSubscriptionAction.bind(null, orgSlug)} label="Cancel subscription" confirmLabel="Cancel at the end of the period"
                    description={`You keep full access until ${fmtDate(sub?.currentPeriodEnd)}. After that the organization becomes read-only — nothing is deleted, and choosing a plan again restores everything.`} />}
              {o.provider?.key === "stripe" ? <ResultButton action={billingPortalAction.bind(null, orgSlug)} label="Payment methods and receipts" /> : null}
            </div>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader title="Usage" description="Today, against your plan's limits." />
          <div className="space-y-4 p-4">
            {(Object.keys(LIMITS) as LimitKey[]).map((k) => <Meter key={k} label={LIMITS[k].label} used={o.usage[k]} limit={ent.limits[k]} />)}
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 text-[13px]">
              <div><div className="text-muted">Active residents</div><div className="tabular-nums">{latest("active_residents")?.toLocaleString("en-CA") ?? "—"}</div></div>
              <div><div className="text-muted">API requests (30 days)</div><div className="tabular-nums">{sum30("api_requests").toLocaleString("en-CA")}</div></div>
              <div><div className="text-muted">Webhook deliveries (30 days)</div><div className="tabular-nums">{sum30("webhook_deliveries").toLocaleString("en-CA")}</div></div>
            </div>
            <p className="text-[12px] text-faint">Residents and vendors don&apos;t use staff seats. Assistant requests reset on the 1st of each month.</p>
          </div>
        </Panel>
      </div>

      <section className="mt-6" aria-labelledby="plans-h">
        <h2 id="plans-h" className="mb-1 text-base font-semibold">Plans</h2>
        <p className="mb-3 text-sm text-muted">Prices in CAD at your current {o.usage.units.toLocaleString("en-CA")} units. Yearly billing charges ten months for twelve. Upgrades apply right away; downgrades at the end of the period.</p>
        {!o.canSelfServe ? <FormAlert kind="info">Plan changes for your organization are handled by support.</FormAlert> : null}
        <div className="grid gap-4 md:grid-cols-3">
          {o.plans.map((p) => {
            const plan = PLANS[p.key];
            const current = p.key === currentKey && sub?.status !== "expired" && sub?.status !== "cancelled";
            const tooSmall = p.violations.length > 0;
            return (
              <Panel key={p.key} data-testid={`plan-${p.key}`} className={cn("flex flex-col p-4", current && "ring-2 ring-accent")}>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold">{plan.name}</h3>
                  {current ? <Badge tone="accent">{sub?.status === "trialing" ? "Trial" : "Current"}</Badge> : null}
                </div>
                <p className="mt-1 text-[13px] text-muted">{plan.tagline}</p>
                <p className="mt-3"><span className="text-2xl font-semibold tabular-nums">{formatMoney(p.monthly.totalCents, p.monthly.currency)}</span><span className="text-[13px] text-muted"> / month</span></p>
                <p className="text-[12px] text-faint">or {formatMoney(p.yearly.totalCents, p.yearly.currency)} / year · {formatMoney(plan.baseMonthlyCents)} base + {formatMoney(plan.perUnitMonthlyCents)} per unit above {plan.includedUnits.toLocaleString("en-CA")}</p>
                <ul className="mt-3 space-y-1 text-[13px]">
                  {(Object.keys(LIMITS) as LimitKey[]).map((k) => <li key={k} className="flex justify-between gap-2"><span className="text-muted">{LIMITS[k].label}</span><span className="tabular-nums">{plan.limits[k] === null ? "Unlimited" : plan.limits[k]!.toLocaleString("en-CA")}</span></li>)}
                </ul>
                <ul className="mt-3 flex-1 space-y-1 text-[13px]">
                  {(Object.keys(FEATURES) as Feature[]).map((f) => (
                    <li key={f} className={plan.features.includes(f) ? "" : "text-faint line-through"}>
                      <span aria-hidden>{plan.features.includes(f) ? "✓ " : "– "}</span>{FEATURES[f].label}<span className="sr-only">{plan.features.includes(f) ? " (included)" : " (not included)"}</span>
                    </li>
                  ))}
                </ul>
                {tooSmall ? <p className="mt-3 text-[12px] text-warning">Too small right now: {p.violations.map(describeViolation).join("; ")}.</p> : null}
                {o.canSelfServe ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {(["month", "year"] as const).map((interval) => {
                      const same = current && sub?.interval === interval && !sub.pendingPlanKey && sub.status !== "trialing";
                      return <ResultButton key={interval} action={changePlanAction.bind(null, orgSlug)} hidden={{ planKey: p.key, interval }} disabled={same || tooSmall}
                        variant={!current && interval === "month" ? "primary" : "secondary"} pendingLabel="One moment…"
                        label={same ? (interval === "month" ? "Your plan (monthly)" : "Your plan (yearly)") : interval === "month" ? `Choose monthly` : `Choose yearly`} />;
                    })}
                  </div>
                ) : null}
              </Panel>
            );
          })}
        </div>
      </section>

      <Panel className="mt-6">
        <PanelHeader title="Invoices" description={o.provider?.development ? "Development invoices (not real charges)." : undefined} />
        {o.invoices.length ? (
          <Table>
            <thead><tr><Th>Invoice</Th><Th>Issued</Th><Th className="hidden md:table-cell">Period</Th><Th className="text-right">Total</Th><Th>Status</Th><Th><span className="sr-only">Details</span></Th></tr></thead>
            <tbody>
              {o.invoices.map((i) => (
                <tr key={i.id} className="align-top">
                  <Td className="font-mono text-[12px] sm:text-[13px]">{i.number}</Td>
                  <Td>{fmtDate(i.issuedAt)}</Td>
                  <Td className="hidden text-muted md:table-cell">{i.periodStart ? `${fmtDate(i.periodStart)} – ${fmtDate(i.periodEnd)}` : "—"}</Td>
                  <Td className="text-right tabular-nums">{formatMoney(i.totalCents, i.currency)}</Td>
                  <Td><Badge tone={INVOICE_TONE[i.status] ?? "neutral"}>{i.status === "paid" ? "Paid" : i.status === "open" ? "Open" : i.status === "void" ? "Void" : "Uncollectible"}</Badge></Td>
                  <Td>
                    {i.hostedUrl ? <a className="text-accent underline" href={i.hostedUrl} target="_blank" rel="noreferrer noopener">View</a> : (
                      <details className="text-[13px]">
                        <summary className="cursor-pointer text-accent">Lines</summary>
                        <ul className="mt-1 space-y-0.5">{(i.lines as { description: string; quantity: number; amountCents: number }[]).map((l, n) => (
                          <li key={n} className="flex justify-between gap-4"><span>{l.description}{l.quantity > 1 ? ` × ${l.quantity.toLocaleString("en-CA")}` : ""}</span><span className="tabular-nums">{formatMoney(l.amountCents, i.currency)}</span></li>
                        ))}</ul>
                      </details>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="p-4 text-sm text-muted">No invoices yet{sub?.status === "trialing" ? " — the trial is free." : "."}</p>}
      </Panel>
    </>
  );
}

