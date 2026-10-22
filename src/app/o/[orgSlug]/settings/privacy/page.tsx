import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { findPeople, getPrivacyOverview } from "@/server/privacy/service";
import { Badge, PageHeader, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Input } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { erasePersonAction, exportPersonAction, placeHoldAction, releaseHoldAction, saveRetentionAction } from "./actions";

export const metadata = { title: "Privacy" };

export default async function PrivacyPage({ params, searchParams }: PageProps<"/o/[orgSlug]/settings/privacy">) {
  const { orgSlug } = await params;
  const q = sp((await searchParams).q) ?? "";
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("privacy.manage")) notFound();
  const [overview, people] = await Promise.all([getPrivacyOverview(ctx), q ? findPeople(ctx, q) : Promise.resolve([])]);
  const tz = principal.orgTimezone;
  const fmt = (d: Date | null) => (d ? d.toLocaleString("en-CA", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }) : "—");
  const ret = overview.retention;
  const val = (n: number | null | undefined) => (n == null ? "" : String(n));
  return (
    <>
      <PageHeader title="Privacy" description="Respond to requests for a person's data, erase it when that's asked for, pause both with a legal hold, and decide how long records are kept. These are tools for meeting privacy obligations (PIPEDA, GDPR principles); whether a request must be honoured is your organization's decision." />
      <Panel className="mt-4" data-testid="privacy-people">
        <PanelHeader title="Find a person" description="Residents and owners, by name or email." />
        <form className="flex gap-2 p-4" role="search">
          <Input name="q" defaultValue={q} placeholder="Name or email" aria-label="Name or email" className="max-w-sm" />
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        {q ? (
          <ul className="divide-y divide-border border-t border-border">
            {people.map((r) => (
              <li key={r.id} className="space-y-3 px-4 py-4">
                <p className="text-sm font-medium">{r.firstName} {r.lastName} <span className="font-normal text-faint">{r.email ?? "no email"}{r.userId ? " · has app access" : ""}</span></p>
                <div className="grid gap-4 lg:grid-cols-3">
                  <SchemaForm action={exportPersonAction.bind(null, orgSlug, r.id)} submitLabel="Export their data" pendingLabel="Collecting…" fields={[]} />
                  <SchemaForm action={placeHoldAction.bind(null, orgSlug, r.id)} submitLabel="Place legal hold" pendingLabel="Saving…" fields={[{ name: "reason", label: "Hold reason", placeholder: "e.g. insurance claim 2026-114" }]} />
                  <SchemaForm action={erasePersonAction.bind(null, orgSlug, r.id)} submitLabel="Erase their data" pendingLabel="Erasing…" fields={[
                    { name: "reason", label: "Why", placeholder: "e.g. request received 2026-10-20" },
                    { name: "confirm", label: "Type ERASE to confirm", hint: "Removes or anonymizes their data here. Building records stay, without their name. Can't be undone." },
                  ]} />
                </div>
              </li>
            ))}
            {!people.length ? <li className="px-4 py-3 text-sm text-muted">Nobody matches “{q}”.</li> : null}
          </ul>
        ) : null}
      </Panel>

      <Panel className="mt-6" data-testid="privacy-requests">
        <PanelHeader title="Requests" description="Every export and erasure, including those a legal hold stopped. Exports can be downloaded for 7 days." />
        {overview.requests.length ? (
          <Table>
            <thead><tr><Th>When</Th><Th>Request</Th><Th>Person</Th><Th>Result</Th><Th className="hidden md:table-cell">By</Th></tr></thead>
            <tbody>
              {overview.requests.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap text-muted">{fmt(r.createdAt)}</Td>
                  <Td>{r.kind === "export" ? "Export" : "Erasure"}</Td>
                  <Td>{r.subjectLabel}</Td>
                  <Td>
                    {r.status === "blocked" ? <Badge tone="warning">Blocked by hold</Badge> : <Badge tone="success">Done</Badge>}
                    {r.downloadable ? <a className="ml-2 text-[13px] text-accent underline" href={`/o/${orgSlug}/settings/privacy/exports/${r.id}`}>Download</a> : null}
                    {r.kind === "erasure" && r.status === "completed" ? <div className="mt-1 text-[12px] text-faint">{Object.entries(r.result as Record<string, number>).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(" · ") || "profile anonymized"}</div> : null}
                  </Td>
                  <Td className="hidden text-muted md:table-cell">{r.requestedBy ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-4 pb-4 text-sm text-muted">No requests yet.</p>}
      </Panel>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Panel data-testid="privacy-holds">
          <PanelHeader title="Legal holds" description="While a hold is in place, nobody can erase that person's data and retention leaves it alone." />
          <ul className="divide-y divide-border">
            {overview.holds.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <span><span className="font-medium">{h.subject}</span> <span className="text-faint">· {h.reason} · since {fmt(h.createdAt)}</span></span>
                <ConfirmAction variant="secondary" action={releaseHoldAction.bind(null, orgSlug, h.id)} label="Release" confirmLabel="Release hold" />
              </li>
            ))}
            {!overview.holds.length ? <li className="px-4 py-3 text-sm text-muted">No active holds.</li> : null}
          </ul>
        </Panel>
        <Panel data-testid="privacy-retention">
          <PanelHeader title="Retention" description="Records older than this are deleted nightly. Blank keeps them. People on legal hold are skipped." />
          <div className="p-4">
            <SchemaForm action={saveRetentionAction.bind(null, orgSlug)} submitLabel="Save retention" pendingLabel="Saving…" columns={2} fields={[
              { name: "messagesDays", label: "Resident messages (days)", type: "number", defaultValue: val(ret?.messagesDays), placeholder: "keep" },
              { name: "visitorsDays", label: "Visitor log (days)", type: "number", defaultValue: val(ret?.visitorsDays), placeholder: "keep" },
              { name: "parkingEvidenceDays", label: "Parking evidence photos (days)", type: "number", defaultValue: val(ret?.parkingEvidenceDays), placeholder: "keep" },
              { name: "assistantDays", label: "Assistant conversations (days)", type: "number", defaultValue: val(ret?.assistantDays), placeholder: "keep" },
              { name: "auditDays", label: "Audit log (days, at least 365)", type: "number", defaultValue: val(ret?.auditDays), placeholder: "keep", span: 2 },
            ]} />
          </div>
        </Panel>
      </div>
    </>
  );
}
