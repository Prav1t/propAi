import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import { UserMenu } from "./user-menu";
import type { SessionUser } from "@/server/auth/service";

// top-bar layout for pages outside an organization
export function SimpleShell({ user, children, wide = false }: { user: SessionUser; children: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-surface">
        <div className={`mx-auto flex h-14 items-center justify-between px-4 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>
          <Link href="/orgs"><Logo /></Link>
          <UserMenu name={user.name} email={user.email} isPlatformAdmin={user.isPlatformAdmin} />
        </div>
      </header>
      <main className={`mx-auto px-4 py-8 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>{children}</main>
    </div>
  );
}
