import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { canManageVisitors, canUseVisitors, visitorFormOptions } from "@/server/modules/visitors/service";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { VisitorForm } from "@/components/frontdesk/visitor-form";
import { VISITOR_KIND } from "@/lib/facility-labels";
import { opts } from "@/lib/labels";
import { zonedParts } from "@/lib/time";
import { registerVisitorAction } from "../../frontdesk-actions";

export const metadata = { title: "Register a visitor" };

export default async function NewVisitorPage({ params }: PageProps<"/o/[orgSlug]/visitors/new">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canUseVisitors(principal)) notFound();
  const staff = canManageVisitors(principal);
  const o = await visitorFormOptions(ctx);
  const tz = o.homes[0]?.tz ?? o.buildings[0]?.tz ?? principal.orgTimezone ?? "America/Vancouver";
  // default window: from the next half hour, for three hours (same day)
  const now = new Date();
  const start = new Date(Math.ceil(now.getTime() / 1_800_000) * 1_800_000);
  const s = zonedParts(start, tz);
  const e = zonedParts(new Date(start.getTime() + 3 * 3_600_000), tz);
  const until = e.date === s.date ? e.time : "23:30";
  return (
    <>
      <Breadcrumbs items={[{ label: staff ? "Visitors" : "My guests", href: `/o/${orgSlug}/visitors` }, { label: staff ? "Register" : "Invite" }]} />
      <PageHeader title={staff ? "Register a visitor" : "Invite a guest"} description={staff ? "Pre-register a guest or contractor, or check in someone who's at the desk now." : "Your guest gets a QR pass to show at the front desk. Passes work from an hour before the time you choose."} />
      <Panel className="max-w-3xl">
        <VisitorForm action={registerVisitorAction.bind(null, orgSlug)} staff={staff} base={`/o/${orgSlug}`}
          homes={o.homes.map((h) => ({ value: h.id, label: h.label }))} buildings={o.buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` }))}
          kinds={opts(VISITOR_KIND)} defaults={{ date: s.date, from: s.time, until }} />
      </Panel>
    </>
  );
}
