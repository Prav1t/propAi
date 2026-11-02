import { notFound } from "next/navigation";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { builderOptions, canManageAutomations, getRule } from "@/server/automation/service";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { PageHeader } from "@/components/ui/primitives";
import { RuleBuilder } from "@/components/automation/rule-builder";
import { candidateEventsAction, dryRunAction, saveRuleAction } from "../../actions";

export const metadata = { title: "Edit automation rule" };

export default async function EditRulePage({ params }: PageProps<"/o/[orgSlug]/automations/[id]/edit">) {
  const { orgSlug, id } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canManageAutomations(principal) || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = await orNotFound(getRule(ctx, id));
  if (!r.editable || !r.input) notFound();
  const options = await builderOptions(ctx);
  return (
    <>
      <Breadcrumbs items={[{ label: "Automations", href: `/o/${orgSlug}/automations` }, { label: r.wf.name, href: `/o/${orgSlug}/automations/${id}` }, { label: "Edit" }]} />
      <PageHeader title={`Edit: ${r.wf.name}`} description={`Saving creates version ${r.wf.version + 1}; runs already in progress keep the steps they started with.`} />
      <RuleBuilder orgSlug={orgSlug} action={saveRuleAction.bind(null, orgSlug, id)} initial={r.input} initialEnabled={r.wf.enabled} options={options} dryRun={dryRunAction} candidates={candidateEventsAction} />
    </>
  );
}
