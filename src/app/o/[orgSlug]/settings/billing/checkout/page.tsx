import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { previewMockCheckout } from "@/server/billing/service";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { FormAlert } from "@/components/ui/form";
import { LinkButton } from "@/components/ui/button";
import { ResultButton } from "@/components/billing/billing-bits";
import { formatMoney } from "@/lib/billing";
import { completeMockCheckoutAction } from "../actions";

export const metadata = { title: "Checkout (development)" };

// the development billing provider's checkout page: what a hosted checkout would show, minus the card
export default async function MockCheckoutPage({ params, searchParams }: PageProps<"/o/[orgSlug]/settings/billing/checkout">) {
  const { orgSlug } = await params;
  const token = sp((await searchParams).token);
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("billing.manage") || !token) notFound();
  const c = await previewMockCheckout(ctx, token);
  const back = `/o/${orgSlug}/settings/billing`;
  if (!c) {
    return (
      <>
        <PageHeader title="Checkout" />
        <FormAlert>This checkout link has expired or belongs to someone else. <Link className="underline" href={back}>Choose the plan again</Link>.</FormAlert>
      </>
    );
  }
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Checkout" description={`${c.plan.name} plan, billed ${c.interval === "year" ? "yearly" : "monthly"}.`} />
      <FormAlert kind="info">Development checkout: no card is needed and nothing is charged. With Stripe configured, this step happens on Stripe&apos;s secure checkout page.</FormAlert>
      <Panel className="mt-4">
        <PanelHeader title="Summary" />
        <ul className="divide-y divide-border text-sm">
          {c.quote.lines.map((l, i) => (
            <li key={i} className="flex justify-between gap-4 px-4 py-2.5"><span>{l.description}{l.quantity > 1 ? ` × ${l.quantity.toLocaleString("en-CA")}` : ""}</span><span className="tabular-nums">{formatMoney(l.amountCents, c.quote.currency)}</span></li>
          ))}
          <li className="flex justify-between gap-4 px-4 py-3 font-semibold"><span>Due today</span><span className="tabular-nums">{formatMoney(c.quote.totalCents, c.quote.currency)}</span></li>
        </ul>
        <div className="flex flex-wrap items-start gap-3 border-t border-border p-4">
          <ResultButton action={completeMockCheckoutAction.bind(null, orgSlug)} hidden={{ session: token }} label="Confirm (no charge)" variant="primary" pendingLabel="Confirming…" />
          <LinkButton href={`${back}?checkout=cancelled`} variant="ghost" size="sm">Cancel</LinkButton>
        </div>
      </Panel>
    </div>
  );
}
