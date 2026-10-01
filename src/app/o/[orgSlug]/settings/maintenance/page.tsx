import { getOrgContext, orNotFound } from "@/server/org-context";
import { getMaintenanceConfig } from "@/server/modules/maintenance/config";
import { PRIORITY_ORDER, WO_CATEGORIES } from "@/server/modules/maintenance/rules";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { ActionButton } from "@/components/ops/action-button";
import { PRIORITY, WO_CATEGORY } from "@/lib/ops-labels";
import { createRuleAction, deleteRuleAction, deleteSlaAction, setRuleActiveAction, upsertSlaAction } from "../../ops-actions";

export const metadata = { title: "Maintenance rules" };

const h = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${(m / 60).toFixed(1)} h`);

export default async function MaintenanceSettingsPage({ params }: PageProps<"/o/[orgSlug]/settings/maintenance">) {
  const { orgSlug } = await params;
  const { ctx } = await getOrgContext(orgSlug);
  const c = await orNotFound(getMaintenanceConfig(ctx));
  const prios = [...PRIORITY_ORDER].reverse();
  const propOpts = [...(c.canEditOrgDefaults ? [{ value: "", label: "Organization default" }] : []), ...c.properties.map((p) => ({ value: p.id, label: p.name }))];
  return (
    <>
      <PageHeader title="Maintenance rules" description="SLA targets and triage rules are applied to every new request. Property settings override organization defaults." />
      <div className="space-y-6">
        <Panel>
          <PanelHeader title="SLA targets" description={`Built-in defaults when nothing is configured: ${prios.map((p) => `${PRIORITY[p].label} ${h(c.defaults[p].respond)}/${h(c.defaults[p].resolve)}`).join(" · ")}.`} />
          {c.sla.length === 0 ? <EmptyState title="Using built-in defaults" /> : (
            <Table>
              <thead><tr><Th>Applies to</Th><Th>Priority</Th><Th className="text-right">First response</Th><Th className="text-right">Resolution</Th><Th /></tr></thead>
              <tbody>
                {c.sla.map(({ s, propertyName }) => (
                  <tr key={s.id}>
                    <Td>{propertyName ?? <span className="text-muted">Organization default</span>}</Td>
                    <Td><Badge tone={PRIORITY[s.priority]?.tone}>{PRIORITY[s.priority]?.label}</Badge></Td>
                    <Td className="text-right tabular-nums">{h(s.respondMinutes)}</Td>
                    <Td className="text-right tabular-nums">{h(s.resolveMinutes)}</Td>
                    <Td className="text-right">{(s.propertyId ? c.properties.some((p) => p.id === s.propertyId) : c.canEditOrgDefaults) ? <ConfirmAction action={deleteSlaAction.bind(null, orgSlug, s.id)} label="Remove" confirmLabel="Remove" variant="secondary" /> : null}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {propOpts.length ? (
            <details className="border-t border-border">
              <summary className="cursor-pointer px-4 py-3 text-[13px] text-accent">Set a target</summary>
              <div className="px-4 pb-4"><SchemaForm action={upsertSlaAction.bind(null, orgSlug)} columns={2} submitLabel="Save target" fields={[
                { name: "propertyId", label: "Applies to", type: "select", options: propOpts },
                { name: "priority", label: "Priority", type: "select", options: prios.map((p) => ({ value: p, label: PRIORITY[p].label })) },
                { name: "respondHours", label: "First response (hours)", type: "number", step: "0.25" },
                { name: "resolveHours", label: "Resolution (hours)", type: "number", step: "0.25" },
              ]} /></div>
            </details>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader title="Triage rules" description="Matched against a new request's title and description (keywords) or category. Matching rules set priority, emergency, category and a default vendor, and can show the requester instructions. Emergencies are always urgent." />
          {c.rules.length === 0 ? <EmptyState title="No rules yet" /> : (
            <ul className="divide-y divide-border">
              {c.rules.map(({ r, propertyName, vendorName, assigneeName }) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{r.name} {!r.active ? <Badge>Disabled</Badge> : null} <span className="text-xs font-normal text-faint">{propertyName ?? "All properties"}</span></p>
                    <p className="text-[13px] text-muted">
                      When {[r.keywords.length ? `text mentions ${r.keywords.map((k) => `“${k}”`).join(" or ")}` : null, r.category ? `category is ${WO_CATEGORY[r.category] ?? r.category}` : null].filter(Boolean).join(" and ")}
                      {" → "}{[r.setEmergency ? "emergency" : null, r.setPriority ? `${PRIORITY[r.setPriority]?.label.toLowerCase()} priority` : null, r.setCategory ? `category ${WO_CATEGORY[r.setCategory]}` : null, vendorName ? `assign ${vendorName}` : null, assigneeName ? `assign ${assigneeName}` : null, r.residentInstructions ? "show instructions" : null].filter(Boolean).join(", ")}
                    </p>
                    {r.residentInstructions ? <p className="mt-1 rounded bg-subtle px-2 py-1 text-xs text-muted">{r.residentInstructions}</p> : null}
                  </div>
                  {(r.propertyId ? c.properties.some((p) => p.id === r.propertyId) : c.canEditOrgDefaults) ? (
                    <div className="flex gap-2">
                      <ActionButton action={setRuleActiveAction.bind(null, orgSlug, r.id, !r.active)} label={r.active ? "Disable" : "Enable"} />
                      <ConfirmAction action={deleteRuleAction.bind(null, orgSlug, r.id)} label="Delete" confirmLabel="Delete rule" />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {propOpts.length ? (
            <details className="border-t border-border">
              <summary className="cursor-pointer px-4 py-3 text-[13px] text-accent">Add a rule</summary>
              <div className="px-4 pb-4"><SchemaForm action={createRuleAction.bind(null, orgSlug)} columns={2} submitLabel="Create rule" resetOnSuccess fields={[
                { name: "name", label: "Name", placeholder: "e.g. Active leaks" },
                { name: "propertyId", label: "Applies to", type: "select", options: propOpts.map((o) => (o.value === "" ? { ...o, label: "All properties" } : o)) },
                { name: "keywords", label: "Keywords (comma-separated)", placeholder: "leak, flooding, water on floor", span: 2 },
                { name: "category", label: "…or category is", type: "select", options: [{ value: "", label: "Any" }, ...WO_CATEGORIES.map((x) => ({ value: x, label: WO_CATEGORY[x] }))] },
                { name: "setPriority", label: "Set priority", type: "select", options: [{ value: "", label: "Don't change" }, ...prios.map((p) => ({ value: p, label: PRIORITY[p].label }))] },
                { name: "setCategory", label: "Set category", type: "select", options: [{ value: "", label: "Don't change" }, ...WO_CATEGORIES.map((x) => ({ value: x, label: WO_CATEGORY[x] }))] },
                { name: "assignVendorId", label: "Assign vendor", type: "select", options: [{ value: "", label: "Nobody" }, ...c.vendors.map((v) => ({ value: v.id, label: v.name }))], hint: "Only applied when the vendor is approved for the request's property." },
                { name: "setEmergency", label: "Flag as emergency", type: "checkbox", span: 2 },
                { name: "residentInstructions", label: "Instructions shown to the requester", type: "textarea", span: 2, hint: "Use your building's approved procedure. Shown verbatim after submission." },
                { name: "position", label: "Order", type: "number", defaultValue: 100, hint: "Lower runs first; property rules always beat organization rules." },
              ]} /></div>
            </details>
          ) : null}
        </Panel>
      </div>
    </>
  );
}
