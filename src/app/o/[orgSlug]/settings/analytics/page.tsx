import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { getAnalyticsSettings } from "@/server/analytics/settings";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { SchemaForm } from "@/components/ui/schema-form";
import { HEALTH_FACTOR_INFO, HEALTH_FACTORS } from "@/lib/analytics-labels";
import { saveAnalyticsSettingsAction } from "./actions";

export const metadata = { title: "Analytics & automation settings" };

export default async function AnalyticsSettingsPage({ params }: PageProps<"/o/[orgSlug]/settings/analytics">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("org.settings.manage")) notFound();
  const s = await getAnalyticsSettings(ctx);
  return (
    <>
      <PageHeader title="Analytics & automation" description="How the property health score is weighted, when the approaching-SLA warning goes out, and when the daily brief is delivered." />
      <Panel>
        <PanelHeader title="Settings" description="Weights are relative (they don't need to add up to 100). A factor with weight 0 is left out of the score." />
        <div className="p-4">
          <SchemaForm action={saveAnalyticsSettingsAction.bind(null, orgSlug)} columns={2} submitLabel="Save" pendingLabel="Saving…" fields={[
            ...HEALTH_FACTORS.map((f) => ({ name: `w_${f}`, label: `Weight: ${HEALTH_FACTOR_INFO[f].label}`, type: "number" as const, defaultValue: s.healthWeights[f], hint: HEALTH_FACTOR_INFO[f].scoring })),
            { name: "slaWarningMinutes", label: "Warn this many minutes before a resolution target", type: "number", defaultValue: s.slaWarningMinutes, hint: "Managers and the assignee get one warning per request; rules can react to it too." },
            { name: "briefTime", label: "Daily brief time (organization time zone)", type: "time", defaultValue: s.briefTime },
            { name: "briefEnabled", label: "Deliver the daily brief to managers every morning", type: "checkbox", defaultValue: s.briefEnabled, span: 2, hint: "People can turn off the email in their notification settings; the brief is always available on the Daily brief page." },
          ]} />
        </div>
      </Panel>
    </>
  );
}
