import Link from "next/link";
import { getOrgContext, sp } from "@/server/org-context";
import { globalSearch } from "@/server/modules/search/service";
import { EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { FilterBar } from "@/components/ui/filter-bar";

export const metadata = { title: "Search" };

const TITLES = { property: "Properties", building: "Buildings", unit: "Units", resident: "Residents", vendor: "Vendors", staff: "Staff" } as const;

export default async function SearchPage({ params, searchParams }: PageProps<"/o/[orgSlug]/search">) {
  const { orgSlug } = await params;
  const q = sp((await searchParams).q) ?? "";
  const { ctx } = await getOrgContext(orgSlug);
  const hits = q ? await globalSearch(ctx, q, 20) : [];
  const groups = (Object.keys(TITLES) as (keyof typeof TITLES)[]).map((t) => ({ type: t, rows: hits.filter((h) => h.type === t) })).filter((g) => g.rows.length);
  return (
    <>
      <PageHeader title="Search" description="Only results you have access to are shown." />
      <Panel className="mb-6"><FilterBar searchPlaceholder="Search properties, units, residents, vendors, staff…" /></Panel>
      {!q ? null : groups.length === 0 ? <Panel><EmptyState title={`No results for “${q}”`} /></Panel> : (
        <div className="space-y-4">
          {groups.map((g) => (
            <Panel key={g.type}>
              <PanelHeader title={TITLES[g.type]} />
              <ul className="divide-y divide-border">
                {g.rows.map((h) => <li key={h.id}><Link href={h.href} className="block px-4 py-2.5 hover:bg-subtle"><span className="text-sm font-medium">{h.title}</span> <span className="text-[13px] text-muted">· {h.subtitle}</span></Link></li>)}
              </ul>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
