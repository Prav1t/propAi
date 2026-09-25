import Link from "next/link";
import { requireSession } from "@/server/auth/session";
import { SimpleShell } from "@/components/shell/simple-shell";

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireSession();
  const tab = "rounded-[var(--radius-md)] px-3 py-1.5 text-[13px] text-muted hover:bg-subtle hover:text-fg";
  return (
    <SimpleShell user={user}>
      <h1 className="text-xl font-semibold tracking-tight">Account</h1>
      <nav className="mt-4 flex gap-1 border-b border-border pb-2" aria-label="Account sections">
        <Link className={tab} href="/account">Profile</Link>
        <Link className={tab} href="/account/security">Security</Link>
        <Link className={tab} href="/orgs?all=1">Organizations</Link>
      </nav>
      <div className="mt-6">{children}</div>
    </SimpleShell>
  );
}
