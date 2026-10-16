import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { propertyHealth } from "@/server/analytics/health";
import { getAnalyticsSettings } from "@/server/analytics/settings";
import { PageHeader, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { HealthBadge, Meter } from "@/components/analytics/bits";

export const metadata = { title: "Property health" };

export default async function HealthPage({ params }: PageProps<"/o/[orgSlug]/analytics/health/[propertyId]">) {
  const { orgSlug, propertyId } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("analytics.read") || !/^[0-9a-f-]{36}$/.test(propertyId)) notFound();
  const [h] = await propertyHealth(ctx, { propertyId });
  if (!h) notFound();
  const st = await getAnalyticsSettings(ctx);
  const base = `/o/${orgSlug}`;
  const used = h.factors.filter((f) => f.score !== null && f.weight > 0);
  const totalWeight = used.reduce((s, f) => s + f.weight, 0);
  return (
    <>
      <PageHeader title={`${h.name} — health`} description={<><Link href={`${base}/analytics`} className="text-accent hover:underline">Analytics</Link> · {h.units} units · score out of 100, from the last 30 days of recorded data (inspections: 90 days)</>} />
      <Panel className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
          <HealthBadge score={h.score} grade={h.grade} />
          <p className="max-w-xl text-[13px] text-muted">
            The score is the weighted average of the factor scores below{used.length < h.factors.length ? " (factors without data are left out, and the others are re-weighted)" : ""}.
            Healthy is 80 or more, Watch is 60–79, Needs attention is under 60.
            {totalWeight ? ` Weights in use add up to ${totalWeight}.` : ""}
          </p>
        </div>
      </Panel>
      <Panel>
        <PanelHeader title="Factors" description="Each factor's raw value, how it's scored, its weight and the points it adds." actions={principal.permissions.has("org.settings.manage") ? <Link href={`${base}/settings/analytics`} className="text-[13px] text-accent hover:underline">Change weights</Link> : null} />
        <div className="overflow-x-auto">
          <Table>
            <thead><tr><Th>Factor</Th><Th>Value</Th><Th>Score</Th><Th className="text-right">Weight</Th><Th className="text-right">Points</Th><Th className="hidden lg:table-cell">How it&apos;s scored</Th><Th className="sr-only">Records</Th></tr></thead>
            <tbody>
              {h.factors.map((f) => (
                <tr key={f.factor} className={f.score === null || f.weight <= 0 ? "text-faint" : undefined}>
                  <Td><div className="font-medium">{f.label}</div><div className="text-[12px] text-faint">{f.measures}</div>{f.unavailable ? <div className="text-[12px] text-faint">{f.unavailable}</div> : null}</Td>
                  <Td className="whitespace-nowrap tabular-nums">{f.valueText}</Td>
                  <Td><Meter value={f.score} label={`${f.label} score`} /></Td>
                  <Td className="text-right tabular-nums">{st.healthWeights[f.factor]}</Td>
                  <Td className="text-right tabular-nums">{f.points ?? "—"}</Td>
                  <Td className="hidden text-[12px] text-muted lg:table-cell">{f.scoring}</Td>
                  <Td className="text-right">{f.href ? <Link href={`${base}${f.href}`} className="text-[13px] text-accent hover:underline">Records</Link> : null}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </Panel>
    </>
  );
}
