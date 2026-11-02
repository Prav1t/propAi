"use client";
import { useParams } from "next/navigation";
import { ErrorView } from "@/components/ui/error-view";

// renders inside the organization shell, so navigation keeps working while one page has failed
export default function OrgError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <ErrorView error={error} retry={retry} home={`/o/${orgSlug}/dashboard`} />;
}
