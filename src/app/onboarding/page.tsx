import { requireSession } from "@/server/auth/session";
import { TIMEZONES } from "@/server/modules/organizations/service";
import { SimpleShell } from "@/components/shell/simple-shell";
import { Panel } from "@/components/ui/primitives";
import { OrgForm } from "./org-form";

export const metadata = { title: "Create organization" };

export default async function OnboardingPage() {
  const session = await requireSession();
  return (
    <SimpleShell user={session.user}>
      <div className="mx-auto max-w-md">
        <h1 className="text-xl font-semibold tracking-tight">Create your organization</h1>
        <p className="mt-1 text-sm text-muted">You&apos;ll be its administrator. You can invite your team next.</p>
        <Panel className="mt-6 p-5"><OrgForm timezones={TIMEZONES} /></Panel>
      </div>
    </SimpleShell>
  );
}
