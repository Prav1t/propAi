import Link from "next/link";
import { Suspense } from "react";
import { getOrgContext } from "@/server/org-context";
import { EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { WoMiniList } from "@/components/ops/wo-mini-list";
import { AskBox } from "@/components/ai/ask-box";
import { listWorkOrders, canListWorkOrders } from "@/server/modules/maintenance/service";
import { ResidentHome } from "./resident-home";
import { DeskConsole } from "../desk/desk-console";
import { SectionBoundary } from "@/components/ui/error-view";
import { ListSkeleton, StatsSkeleton } from "@/components/ui/skeleton";
import { faultPoint } from "@/server/dev-faults";
import { AttentionSection, CommunitySection, FacilitySection, MyWorkSection, OpsSection, PortfolioSection } from "./sections";

export const metadata = { title: "Dashboard" };

// a section that streams in with its own placeholder and fails on its own
function Section({ title, fallback, children }: { title: string; fallback: React.ReactNode; children: React.ReactNode }) {
  return <SectionBoundary title={title} className="mb-6"><Suspense fallback={fallback}>{children}</Suspense></SectionBoundary>;
}

export default async function DashboardPage({ params }: PageProps<"/o/[orgSlug]/dashboard">) {
  const { orgSlug } = await params;
  // identity and permissions are settled before anything streams, so redirects and 404s keep their status codes
  const { ctx, principal, session } = await getOrgContext(orgSlug);
  await faultPoint("dashboard");
  const first = session.user.name.split(" ")[0];

  const base = `/o/${orgSlug}`;
  if (principal.role.scopeLevel === "occupant") return <ResidentHome ctx={ctx} principal={principal} first={first} base={base} />;
  // the front desk's home is the desk console
  if (["concierge", "security"].includes(principal.role.key)) return <DeskConsole ctx={ctx} principal={principal} orgSlug={orgSlug} title={`Hi ${first}`} />;

  if (!principal.permissions.has("property.read")) {
    const jobs = canListWorkOrders(principal) ? await listWorkOrders(ctx, { view: "open", pageSize: 10 }) : null;
    return (
      <>
        <PageHeader title={`Hi ${first}`} description={principal.vendorId ? `Jobs from ${principal.orgName}` : principal.orgName} />
        <Panel>
          <PanelHeader title="Open jobs" description={jobs ? `${jobs.total} open` : undefined} actions={jobs ? <Link href={`${base}/maintenance`} className="text-[13px] text-accent hover:underline">All jobs</Link> : null} />
          {jobs ? <WoMiniList rows={jobs.rows} base={base} empty="Nothing assigned to you right now" /> : <EmptyState title="Nothing assigned to you yet">Work assigned to you by {principal.orgName} will appear here.</EmptyState>}
        </Panel>
      </>
    );
  }

  const scoped = principal.role.scopeLevel === "scoped";
  // what each role looks at first: equipment for facility managers, their own work for maintenance staff
  const facilityFirst = principal.role.key === "facility_manager";
  const workFirst = ["maintenance_staff", "staff"].includes(principal.role.key);
  const s = { ctx, base };
  const attention = <Section key="attention" title="Approvals and insights" fallback={<ListSkeleton label="approvals and insights" rows={3} className="mb-6" />}><AttentionSection {...s} /></Section>;
  const facility = <Section key="facility" title="Facility" fallback={<StatsSkeleton label="facility" className="mb-6" />}><FacilitySection {...s} first={facilityFirst} /></Section>;
  const mine = <Section key="mine" title="Your work" fallback={<ListSkeleton label="your work" rows={4} className="mb-6" />}><MyWorkSection {...s} /></Section>;
  const ops = <Section key="ops" title="Operations" fallback={<StatsSkeleton label="operations" count={6} className="mb-6 md:grid-cols-3 xl:grid-cols-6" />}><OpsSection {...s} /></Section>;
  const community = <Section key="community" title="Front desk and community" fallback={<StatsSkeleton label="front desk and community" className="mb-6" />}><CommunitySection {...s} /></Section>;
  const portfolio = <Section key="portfolio" title="Portfolio" fallback={<StatsSkeleton label="portfolio" count={5} className="md:grid-cols-3 xl:grid-cols-5" />}><PortfolioSection {...s} /></Section>;
  const order = facilityFirst ? [facility, mine, attention, ops, community, portfolio]
    : workFirst ? [mine, attention, ops, facility, community, portfolio]
    : [attention, ops, community, facility, mine, portfolio];

  return (
    <>
      <PageHeader
        title={`Good to see you, ${first}`}
        description={scoped ? `Showing the properties assigned to you as ${principal.role.name}.` : `Portfolio overview for ${principal.orgName}.`}
      />
      {principal.permissions.has("ai.use") ? <AskBox base={base} placeholder="Ask anything — “Which work orders are overdue at Fraser Towers?”" className="mb-6" /> : null}
      {order}
    </>
  );
}
