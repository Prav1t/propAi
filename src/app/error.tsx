"use client";
import { ErrorView } from "@/components/ui/error-view";

// pages outside an organization (sign-in, account, platform admin)
export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main id="main" className="px-4">
      <ErrorView error={error} retry={retry} home="/orgs" homeLabel="Go to your organizations" />
    </main>
  );
}
