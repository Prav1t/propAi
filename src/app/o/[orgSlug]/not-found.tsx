"use client";
import Link from "next/link";
import { useParams } from "next/navigation";

// also what someone sees for records they aren't allowed to open: the wording doesn't confirm the record exists
export default function OrgNotFound() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const base = `/o/${orgSlug}`;
  return (
    <section aria-labelledby="nf-title" className="mx-auto max-w-lg py-16 text-center" data-testid="not-found">
      <title>Not found</title>
      <h1 id="nf-title" className="text-lg font-semibold tracking-tight">We couldn&apos;t find that</h1>
      <p className="mt-2 text-sm text-muted">It may have been moved or deleted, or it isn&apos;t available to your account.</p>
      <div className="mt-6 flex justify-center gap-2">
        <Link href={`${base}/dashboard`} className="inline-flex h-9 items-center rounded-[var(--radius-md)] bg-accent px-4 text-sm font-medium text-accent-fg hover:opacity-90">Go to dashboard</Link>
        <Link href={`${base}/search`} className="inline-flex h-9 items-center rounded-[var(--radius-md)] border border-border-strong px-4 text-sm font-medium hover:bg-subtle">Search</Link>
      </div>
    </section>
  );
}
