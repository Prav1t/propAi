import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { builderOptions, canManageAutomations } from "@/server/automation/service";
import { PageHeader } from "@/components/ui/primitives";
import { RuleBuilder } from "@/components/automation/rule-builder";
import { TEMPLATES } from "@/lib/automation-templates";
import type { WorkflowInput } from "@/lib/automation";
import { candidateEventsAction, dryRunAction, saveRuleAction } from "../actions";

export const metadata = { title: "New automation rule" };

export default async function NewRulePage({ params, searchParams }: PageProps<"/o/[orgSlug]/automations/new">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canManageAutomations(principal)) notFound();
  const options = await builderOptions(ctx);
  const tpl = TEMPLATES.find((t) => t.key === sp(q.template));
  const propertyId = options.orgWide ? null : options.properties[0]?.id ?? null;
  const initial: WorkflowInput = tpl ? { ...tpl.rule, propertyId } : {
    name: "", description: "", propertyId, trigger: "workorder.created", schedule: null, conditions: [],
    actions: [{ type: "notify", to: { roles: ["property_manager"], members: [], onCall: false, submitter: false, assignee: false }, title: "{{ref}}: {{title}}", message: "" }],
  };
  return (
    <>
      <PageHeader title={tpl ? `New rule: ${tpl.title}` : "New rule"} description={<><Link href={`/o/${orgSlug}/automations`} className="text-accent hover:underline">Automations</Link>{tpl ? ` · ${tpl.about}` : " · Choose what starts it, when it applies, and what it does."}</>} />
      <RuleBuilder orgSlug={orgSlug} action={saveRuleAction.bind(null, orgSlug, null)} initial={initial} initialEnabled={false} options={options} dryRun={dryRunAction} candidates={candidateEventsAction} />
    </>
  );
}
