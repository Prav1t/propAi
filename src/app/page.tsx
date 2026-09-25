import { redirect } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { LinkButton } from "@/components/ui/button";
import { BRAND } from "@/config/brand";
import { getSession } from "@/server/auth/session";

// signed-in users go straight to their workspace
export default async function Home() {
  if (await getSession()) redirect("/orgs");
  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-6">
      <header className="flex items-center justify-between py-6">
        <Logo />
        <LinkButton href="/login" variant="ghost" size="sm">Sign in</LinkButton>
      </header>
      <main className="flex flex-1 flex-col justify-center pb-24">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Building operations, handled.</h1>
        <p className="mt-4 max-w-xl text-base text-muted">
          {BRAND.name} brings maintenance, residents, front desk and facilities into one workspace — with {BRAND.assistantName} planning the busywork and asking before it acts.
        </p>
        <div className="mt-8 flex gap-3">
          <LinkButton href="/register">Create an account</LinkButton>
          <LinkButton href="/login" variant="secondary">Sign in</LinkButton>
        </div>
      </main>
    </div>
  );
}
