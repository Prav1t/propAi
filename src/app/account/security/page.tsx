import { requireSession } from "@/server/auth/session";
import { listSessions, loginHistory, remainingRecoveryCodes } from "@/server/auth/service";
import { revokeOtherSessionsAction, revokeSessionAction } from "../actions";
import { Badge, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form";
import { listMyOrganizations } from "@/server/modules/organizations/principal";
import { MfaDisable, MfaSetup, PasswordForm } from "./security-forms";

export const metadata = { title: "Security" };

// short device label from a user agent string
function device(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
const when = (d: Date) => d.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });

export default async function SecurityPage({ searchParams }: PageProps<"/account/security">) {
  const s = await requireSession();
  const requiredSlug = (await searchParams).required;
  // the organization's name comes from the person's own memberships, never from the URL
  const requiredBy = typeof requiredSlug === "string" ? (await listMyOrganizations(s.user.id)).find((o) => o.slug === requiredSlug)?.name : undefined;
  const [sessions, history, remaining] = await Promise.all([listSessions(s.user.id), loginHistory(s.user.id, 15), remainingRecoveryCodes(s.user.id)]);
  return (
    <div className="space-y-6">
      {requiredBy && !s.user.mfaEnabled ? (
        <FormAlert kind="info">{`${requiredBy} requires two-step verification. Turn it on below, then open the organization again.`}</FormAlert>
      ) : null}
      {s.user.hasPassword ? <Panel><PanelHeader title="Password" /><PasswordForm /></Panel> : null}
      <Panel>
        <PanelHeader title="Two-factor authentication" description={s.user.mfaEnabled ? undefined : "Recommended for everyone, required soon for admins."} actions={s.user.mfaEnabled ? <Badge tone="success">On</Badge> : <Badge tone="warning">Off</Badge>} />
        {s.user.mfaEnabled ? <MfaDisable remaining={remaining} /> : <MfaSetup />}
      </Panel>
      <Panel>
        <PanelHeader title="Active sessions" description="Devices currently signed in to your account." actions={sessions.length > 1 ? (
          <form action={revokeOtherSessionsAction}><Button type="submit" variant="secondary" size="sm">Sign out other sessions</Button></form>
        ) : null} />
        <ul className="divide-y divide-border">
          {sessions.map((x) => (
            <li key={x.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-sm font-medium">{device(x.userAgent)} {x.id === s.sessionId ? <Badge tone="accent">This device</Badge> : null}</p>
                <p className="text-xs text-faint">{x.ip ?? "Unknown IP"} · last active {when(x.lastSeenAt)}</p>
              </div>
              {x.id !== s.sessionId ? (
                <form action={revokeSessionAction}><input type="hidden" name="sessionId" value={x.id} /><Button type="submit" variant="ghost" size="sm">Sign out</Button></form>
              ) : null}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel>
        <PanelHeader title="Recent sign-in activity" />
        <Table>
          <thead><tr><Th>When</Th><Th>Result</Th><Th className="hidden sm:table-cell">Device</Th><Th className="hidden sm:table-cell">IP</Th></tr></thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <Td className="whitespace-nowrap text-muted">{when(h.createdAt)}</Td>
                <Td>
                  {h.success ? <Badge tone="success">Signed in</Badge> : h.reason === "mfa_required" ? <Badge>Password OK, 2FA pending</Badge> : <Badge tone="danger">Failed{h.reason ? ` · ${h.reason.replace("_", " ")}` : ""}</Badge>}
                  {h.suspicious ? <Badge tone="warning" className="ml-1">New device</Badge> : null}
                </Td>
                <Td className="hidden text-muted sm:table-cell">{device(h.userAgent)}</Td>
                <Td className="hidden font-mono text-xs text-faint sm:table-cell">{h.ip ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </div>
  );
}
