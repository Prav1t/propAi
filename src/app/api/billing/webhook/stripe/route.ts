import { stripeProvider, applyBillingEvents } from "@/server/billing/service";
import { WebhookSignatureError } from "@/server/billing/providers/stripe";
import { log } from "@/server/log";

export const dynamic = "force-dynamic";

// Stripe → us. Authenticated by the Stripe-Signature header (no cookies, no CSRF surface). Events are applied once each;
// a 5xx makes Stripe retry, a 400 means the signature was wrong.
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 512 * 1024) return Response.json({ error: "Payload too large." }, { status: 413 });
  let provider;
  try {
    provider = stripeProvider();
  } catch {
    return Response.json({ error: "Stripe isn't configured on this deployment." }, { status: 404 });
  }
  try {
    const events = provider.parseWebhook(raw, req.headers);
    const r = await applyBillingEvents(events);
    return Response.json({ received: true, ...r });
  } catch (e) {
    if (e instanceof WebhookSignatureError || e instanceof SyntaxError) return Response.json({ error: "Invalid signature or payload." }, { status: 400 });
    log.error("billing.stripe_webhook_failed", { err: e });
    return Response.json({ error: "Not processed; retry." }, { status: 500 });
  }
}
