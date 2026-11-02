"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { catchError, type ErrorInfo } from "next/error";
import { Button } from "./button";

type Err = Error & { digest?: string };

// server errors reach the browser as a generic message plus a digest; the digest is the same id the server logged
// (see src/instrumentation.ts), so support can find the exact failure
export function ErrorReference({ error }: { error: Err }) {
  if (!error.digest) return null;
  return (
    <p className="mt-3 text-xs text-faint">
      Reference: <code className="select-all rounded bg-subtle px-1.5 py-0.5 font-mono text-muted">{error.digest}</code>
    </p>
  );
}

// full-page fallback inside the app shell: what happened, what to try, and a reference for support
export function ErrorView({ error, retry, home, homeLabel = "Go to dashboard" }: { error: Err; retry: () => void; home: string; homeLabel?: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus(); // move focus so keyboard and screen-reader users land on the explanation
    if (!error.digest) console.error(error); // client-side errors never reach the server log
  }, [error]);
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  return (
    <section role="alert" aria-labelledby="error-title" className="mx-auto max-w-lg py-16 text-center">
      <h1 id="error-title" ref={heading} tabIndex={-1} className="text-lg font-semibold tracking-tight outline-none">
        {offline ? "You're offline" : "Something went wrong"}
      </h1>
      <p className="mt-2 text-sm text-muted">
        {offline
          ? "This page needs a connection. Check your network and try again."
          : "This page couldn't load. Nothing you entered was lost, and trying again usually works. If it keeps happening, contact support with the reference below."}
      </p>
      <ErrorReference error={error} />
      <div className="mt-6 flex justify-center gap-2">
        <Button type="button" onClick={() => retry()}>Try again</Button>
        <Link href={home} className="inline-flex h-9 items-center rounded-[var(--radius-md)] border border-border-strong px-4 text-sm font-medium hover:bg-subtle">{homeLabel}</Link>
      </div>
    </section>
  );
}

// one panel failing (an insight query, a chart) shouldn't take the whole page down with it
function SectionFallback({ title, className }: { title: string; className?: string }, { error, retry }: ErrorInfo) {
  return (
    <div role="alert" className={`rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-4 text-[13px] ${className ?? ""}`} data-section-error={title}>
      <p className="font-medium">{title} couldn&apos;t load.</p>
      <p className="mt-0.5 text-muted">The rest of the page is fine.</p>
      <ErrorReference error={error as Err} />
      <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => retry()}>Try again</Button>
    </div>
  );
}
export const SectionBoundary = catchError(SectionFallback);
