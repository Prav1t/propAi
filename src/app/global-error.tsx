"use client";
import "./globals.css";
import { ErrorView } from "@/components/ui/error-view";

// last resort when the root layout itself fails: renders its own document
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-dvh px-4">
        <title>Something went wrong</title>
        <main id="main">
          <ErrorView error={error} retry={retry} home="/orgs" homeLabel="Go to your organizations" />
        </main>
      </body>
    </html>
  );
}
