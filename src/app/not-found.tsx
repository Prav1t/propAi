import Link from "next/link";
import { Logo } from "@/components/brand/logo";

export const metadata = { title: "Page not found" };

// unmatched URLs and notFound() outside an organization
export default function NotFound() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
      <Logo />
      <h1 className="mt-8 text-lg font-semibold tracking-tight">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">The link may be mistyped or out of date.</p>
      <Link href="/orgs" className="mt-6 inline-flex h-9 items-center rounded-[var(--radius-md)] bg-accent px-4 text-sm font-medium text-accent-fg hover:opacity-90">
        Go to your organizations
      </Link>
    </main>
  );
}
