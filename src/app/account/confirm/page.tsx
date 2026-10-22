import Link from "next/link";
import { requireSession } from "@/server/auth/session";
import { safeNext } from "@/lib/safe-next";
import { Panel, PanelHeader } from "@/components/ui/primitives";
import { ConfirmForm } from "./confirm-form";

export const metadata = { title: "Confirm it's you" };

// asked before sensitive changes when the last sign-in or confirmation is more than a few minutes old
export default async function ConfirmPage({ searchParams }: PageProps<"/account/confirm">) {
  const s = await requireSession();
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === "string" ? sp.next : null) ?? "/orgs";
  const method = s.user.hasPassword ? "password" : s.user.mfaEnabled ? "code" : s.ssoConnectionId ? "sso" : "none";
  return (
    <Panel className="max-w-lg">
      <PanelHeader title="Confirm it's you" description="This change needs a recent sign-in. Confirm, and you'll go straight back to where you were." />
      <div className="p-4">
        {method === "sso" ? (
          <Link className="text-sm font-medium text-accent underline" href={`/sso/reauth?next=${encodeURIComponent(next)}`}>Continue with your organization&apos;s sign-in</Link>
        ) : method === "none" ? (
          <p className="text-sm text-muted">Set a password or two-step verification under <Link className="text-accent underline" href="/account/security">Security</Link> first.</p>
        ) : (
          <ConfirmForm next={next} method={method} />
        )}
      </div>
    </Panel>
  );
}
