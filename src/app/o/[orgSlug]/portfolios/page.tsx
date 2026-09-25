import Link from "next/link";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { listPortfolios } from "@/server/modules/portfolio/service";
import { can } from "@/server/authz/authorize";
import { EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { createPortfolioAction, deletePortfolioAction, updatePortfolioAction } from "../portfolio-actions";

export const metadata = { title: "Portfolios" };

export default async function PortfoliosPage({ params }: PageProps<"/o/[orgSlug]/portfolios">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const rows = await orNotFound(listPortfolios(ctx));
  const orgAdmin = principal.role.scopeLevel === "org" && can(principal, "portfolio.manage");
  return (
    <>
      <PageHeader title="Portfolios" description="Group properties for reporting and to scope managers' access." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          {rows.length === 0 ? <Panel><EmptyState title="No portfolios yet" /></Panel> : rows.map((pf) => {
            const editable = can(principal, "portfolio.manage", { orgId: principal.orgId, portfolioId: pf.id });
            return (
              <Panel key={pf.id}>
                <PanelHeader title={pf.name} description={pf.description ?? undefined} actions={
                  <Link className="text-[13px] text-accent hover:underline" href={`/o/${orgSlug}/properties?portfolio=${pf.id}`}>{pf.propertyCount} {pf.propertyCount === 1 ? "property" : "properties"}</Link>
                } />
                {editable ? (
                  <details className="px-4 py-2">
                    <summary className="cursor-pointer text-[13px] text-muted">Edit</summary>
                    <div className="space-y-3 py-3">
                      <SchemaForm action={updatePortfolioAction.bind(null, orgSlug, pf.id)} submitLabel="Save" fields={[
                        { name: "name", label: "Name", defaultValue: pf.name },
                        { name: "description", label: "Description", type: "textarea", defaultValue: pf.description },
                      ]} />
                      {orgAdmin ? <ConfirmAction action={deletePortfolioAction.bind(null, orgSlug, pf.id)} label="Delete portfolio" confirmLabel="Delete" description="Properties stay; they just won't belong to a portfolio." /> : null}
                    </div>
                  </details>
                ) : null}
              </Panel>
            );
          })}
        </div>
        {orgAdmin ? (
          <Panel className="h-fit">
            <PanelHeader title="New portfolio" />
            <div className="p-4"><SchemaForm action={createPortfolioAction.bind(null, orgSlug)} submitLabel="Create" resetOnSuccess fields={[
              { name: "name", label: "Name", required: true },
              { name: "description", label: "Description", type: "textarea" },
            ]} /></div>
          </Panel>
        ) : null}
      </div>
    </>
  );
}
