import Link from "next/link";
import { notFound } from "next/navigation";
import { PLANS, isPlanKey } from "@/config/plans";
import { getOrgContext } from "@/server/org-context";
import { getOrganization, orgSettings, TIMEZONES } from "@/server/modules/organizations/service";
import { can } from "@/server/authz/authorize";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { GeneralForm } from "./general-form";

export const metadata = { title: "Organization settings" };

export default async function SettingsPage({ params }: PageProps<"/o/[orgSlug]/settings">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!can(principal, "org.settings.manage")) notFound();
  const org = await getOrganization(ctx);
  return (
    <>
      <PageHeader title="Organization settings" description="Profile and defaults for your organization." />
      <div className="space-y-6">
        <Panel>
          <PanelHeader title="General" />
          <GeneralForm orgSlug={orgSlug} name={org.name} timezone={org.timezone} timezones={TIMEZONES} parkingSecondReviewer={!!orgSettings(org.settings).parkingSecondReviewer} />
        </Panel>
        <Panel>
          <PanelHeader title="Workspace" />
          <dl className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-[160px_1fr]">
            <dt className="text-muted">URL</dt><dd className="font-mono text-[13px]">/o/{org.slug}</dd>
            <dt className="text-muted">Type</dt><dd>{org.kind.replace("_", " ")}</dd>
            <dt className="text-muted">Plan</dt><dd><Badge tone="accent">{isPlanKey(org.planKey) ? PLANS[org.planKey].name : org.planKey}</Badge> {principal.permissions.has("billing.manage") ? <Link className="text-[13px] text-accent underline" href={`/o/${orgSlug}/settings/billing`}>Plan and billing</Link> : null}</dd>
            <dt className="text-muted">Created</dt><dd>{org.createdAt.toLocaleDateString("en-CA", { dateStyle: "long" })}</dd>
          </dl>
        </Panel>
      </div>
    </>
  );
}
