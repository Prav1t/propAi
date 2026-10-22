import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { getSecuritySettings } from "@/server/sso/service";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { FormAlert } from "@/components/ui/form";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { SSO_PROVIDER_KEYS, SSO_PROVIDERS } from "@/lib/sso";
import { addDomainAction, removeDomainAction, saveConnectionAction, savePolicyAction, setConnectionStatusAction, verifyDomainAction } from "./actions";

export const metadata = { title: "Security" };

export default async function SecuritySettingsPage({ params }: PageProps<"/o/[orgSlug]/settings/security">) {
  const { orgSlug } = await params;
  const { ctx, principal, session } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("security.manage")) notFound();
  const s = await getSecuritySettings(ctx);
  const tz = principal.orgTimezone;
  const fmt = (d: Date | null) => (d ? d.toLocaleString("en-CA", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }) : "—");
  const c = s.connection;
  const verified = s.domains.filter((d) => d.verifiedAt);
  return (
    <>
      <PageHeader title="Security" description="How people sign in to your organization. Changes here need a recent sign-in and are recorded in the audit log." />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel data-testid="security-policy">
          <PanelHeader title="Sign-in requirements" description="Checked on every request, so they apply to people who are already signed in." />
          <div className="space-y-3 p-4">
            {!session.user.mfaEnabled ? <FormAlert kind="info">Turn on two-step verification for your own account before requiring it from others.</FormAlert> : null}
            <SchemaForm action={savePolicyAction.bind(null, orgSlug)} submitLabel="Save requirements" pendingLabel="Saving…" fields={[
              { name: "requireMfa", label: "Two-step verification", type: "select", defaultValue: s.policy.requireMfa, options: [
                { value: "off", label: "Optional" }, { value: "staff", label: "Required for staff" }, { value: "everyone", label: "Required for everyone (staff, residents, vendors)" },
              ], hint: "Signing in through your SSO counts: your identity provider handles multi-factor for those accounts." },
              { name: "requireSso", label: "Staff sign in with SSO", type: "select", defaultValue: s.policy.requireSso ? "on" : "off", options: [
                { value: "off", label: "No — passwords allowed" }, { value: "on", label: "Yes — staff must use single sign-on" },
              ], hint: "Organization admins can still use a password with two-step verification, so a broken identity provider can't lock you out. Residents and vendors are unaffected." },
            ]} />
          </div>
        </Panel>

        <Panel data-testid="sso-connection">
          <PanelHeader title="Single sign-on (OpenID Connect)" description="Google Workspace, Microsoft Entra ID, Okta or any OpenID Connect provider."
            actions={c ? (c.status === "active" ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>) : <Badge>Not set up</Badge>} />
          <div className="space-y-4 p-4 text-sm">
            <p className="text-[13px] text-muted">Register this redirect URI with your provider: <code className="break-all font-mono text-[12px] text-fg">{s.callbackUrl}</code></p>
            {c ? (
              <dl className="space-y-1 text-[13px]">
                <div className="flex justify-between gap-3"><dt className="text-muted">Provider</dt><dd>{SSO_PROVIDERS[c.provider as keyof typeof SSO_PROVIDERS]?.name ?? c.provider}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted">Issuer</dt><dd className="break-all font-mono text-[12px]">{c.issuer}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted">Client secret</dt><dd>stored encrypted</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted">Last SSO sign-in</dt><dd>{fmt(c.lastLoginAt)}</dd></div>
              </dl>
            ) : null}
            <SchemaForm action={saveConnectionAction.bind(null, orgSlug)} submitLabel={c ? "Save" : "Set up single sign-on"} pendingLabel="Checking the provider…" fields={[
              { name: "provider", label: "Provider", type: "select", defaultValue: c?.provider ?? "google", options: SSO_PROVIDER_KEYS.map((k) => ({ value: k, label: SSO_PROVIDERS[k].name })) },
              { name: "issuerInput", label: "Tenant ID, Okta domain or issuer URL", defaultValue: c && c.provider !== "google" ? (c.provider === "microsoft" ? c.issuer.split("/")[3] : c.provider === "okta" ? c.issuer.replace(/^https:\/\//, "") : c.issuer) : "",
                hint: "Not needed for Google. Microsoft: the directory (tenant) ID. Okta: your Okta domain. Other: the issuer URL." },
              { name: "clientId", label: "Client ID", defaultValue: c?.clientId ?? "" },
              { name: "clientSecret", label: c ? "Client secret (leave blank to keep the stored one)" : "Client secret", defaultValue: "" },
              { name: "jitRoleId", label: "People from your verified domains who aren't members yet", type: "select", defaultValue: c?.jitRoleId ?? "",
                options: [{ value: "", label: "Can't sign in until invited" }, ...s.jitRoles.map((r) => ({ value: r.id, label: `Join as ${r.name}` }))] },
              { name: "jitPropertyId", label: "…with access to (for property-level roles)", type: "select", defaultValue: c?.jitPropertyId ?? "",
                options: [{ value: "", label: "—" }, ...s.properties.map((p) => ({ value: p.id, label: p.name }))] },
            ]} />
            {c ? (
              c.status === "active"
                ? <ConfirmAction action={setConnectionStatusAction.bind(null, orgSlug, "disabled")} label="Switch off single sign-on" confirmLabel="Switch off" description="Staff will sign in with passwords again, and the SSO requirement is lifted." />
                : <ConfirmAction variant="secondary" action={setConnectionStatusAction.bind(null, orgSlug, "active")} label="Switch on single sign-on" confirmLabel="Switch on" />
            ) : null}
          </div>
        </Panel>

        <Panel className="lg:col-span-2" data-testid="sso-domains">
          <PanelHeader title="Verified domains" description="Only email addresses on these domains can sign in through your SSO. Prove you control a domain with a DNS TXT record." />
          <ul className="divide-y divide-border">
            {s.domains.map((d) => (
              <li key={d.id} className="space-y-2 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{d.domain} {d.verifiedAt ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Waiting for DNS</Badge>}</span>
                  <ConfirmAction action={removeDomainAction.bind(null, orgSlug, d.id)} label="Remove" confirmLabel="Remove" description="People on this domain will no longer be able to use your SSO." />
                </div>
                {!d.verifiedAt ? (
                  <>
                    <p className="text-[13px] text-muted">Add a TXT record named <code className="font-mono text-[12px] text-fg">{d.recordName}</code> with the value <code className="break-all font-mono text-[12px] text-fg">{d.recordValue}</code></p>
                    {d.lastCheckError ? <p className="text-[13px] text-danger">Last check ({fmt(d.lastCheckedAt)}): {d.lastCheckError}</p> : null}
                    <SchemaForm action={verifyDomainAction.bind(null, orgSlug, d.id)} submitLabel="Check DNS now" pendingLabel="Checking…" fields={[]} />
                  </>
                ) : <p className="text-[13px] text-faint">Verified {fmt(d.verifiedAt)}</p>}
              </li>
            ))}
            {!s.domains.length ? <li className="px-4 py-3 text-sm text-muted">No domains yet.</li> : null}
          </ul>
          <div className="border-t border-border p-4">
            <SchemaForm action={addDomainAction.bind(null, orgSlug)} submitLabel="Add domain" pendingLabel="Adding…" resetOnSuccess fields={[{ name: "domain", label: "Domain", placeholder: "example.com" }]} />
          </div>
          {verified.length === 0 && c ? <div className="px-4 pb-4"><FormAlert kind="info">Verify at least one domain before anyone can use single sign-on.</FormAlert></div> : null}
        </Panel>
      </div>
    </>
  );
}
