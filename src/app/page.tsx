import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import "@fontsource-variable/archivo/wdth.css";
import { Logo } from "@/components/brand/logo";
import { BuildingDemo } from "@/components/marketing/building-demo";
import { AskDemo, Pricing, Roles } from "@/components/marketing/sections";
import css from "@/components/marketing/landing.module.css";
import { BRAND } from "@/config/brand";
import { PLANS, TRIAL_PLAN } from "@/config/plans";
import { cn } from "@/lib/cn";
import { getSession } from "@/server/auth/session";

export const metadata: Metadata = {
  title: `${BRAND.name}: building operations with an assistant that asks first`,
  description: "Maintenance, front desk, amenities, parking and resident requests in one workspace. The assistant turns a sentence into a plan you can read, edit and approve.",
  robots: { index: true, follow: true },
};

const MODULES: [string, string][] = [
  ["Maintenance", "Requests with photos, triage rules, SLAs, vendors, costs and a history for every job."],
  ["Inspections", "Checklists, recurring schedules, pass or fail with severity, and follow-up tasks."],
  ["Incidents and complaints", "Timelines, evidence, people involved, escalation and resolution."],
  ["Amenities and notices", "Booking calendars with rules, deposits and approvals; announcements and messages."],
  ["Packages and visitors", "Arrival to pickup, guest passes with QR codes, check-in and check-out."],
  ["Parking", "Spaces, permits, vehicles, visitor parking and violations with evidence."],
  ["Documents", "Versions and permissions, searchable, and readable by the assistant with citations."],
  ["Meetings and motions", "Agendas, votes with the threshold each motion needs, minutes that lock on approval."],
  ["Leases and rent", "Terms, renewals and notice, monthly rent charges, and what has been received."],
  ["Assets and upkeep", "An equipment register, preventive schedules, downtime and cost per asset."],
  ["Analytics", "SLA compliance, vendor scorecards, spending, and a health score that shows its working."],
  ["Automation", "When this happens, if these conditions hold, do that. With an approval step where you want one."],
  ["API and webhooks", "A versioned REST API with scoped keys, signed webhooks, Slack, Teams and SMS."],
];

const CLASSES: [string, string, string][] = [
  ["Look things up", "Search, summarize, answer from documents.", "Runs straight away, inside your permissions."],
  ["Small internal changes", "Create a task, draft a notice, add a note.", "Runs or asks: your organization decides."],
  ["Messages to people", "Notify residents, email a vendor.", "One click from a person, every time, by default."],
  ["Changes with consequences", "Enforcement, resident records, money.", "Needs an explicit acknowledgement."],
  ["Things that can’t be undone", "Deleting records, bulk removals.", "Needs a typed confirmation. No rule can waive it."],
];

const FAQ: [string, string][] = [
  ["Does the assistant act on its own?", "It reads on its own. Anything that changes a record or reaches a person is shown to you first as a plan with every step listed, unless your organization has allowed that kind of small change to run without asking. Messages to residents and vendors wait for a person by default, and every step, approved or declined, is written to the audit log."],
  ["Can it see data from other buildings or companies?", "No. The assistant works through the same permission checks as the person using it: a manager of one property can’t ask about another, and a resident sees only their own unit. Each organization’s records are separated in the database itself, not only in the screens."],
  ["Which AI model does it use?", "The one you choose. It works with Anthropic and OpenAI models, and with self-hosted models that speak the same API. Without a model configured it runs in a clearly labelled demo mode, which is what you see on a trial until a model is connected."],
  ["Do residents need to install an app?", "No. It runs in the browser and can be added to a phone’s home screen from there. Residents can write a maintenance request with no signal and it is sent when the connection returns."],
  ["Can we connect it to what we already use?", "Yes. There is a REST API with scoped keys, signed webhooks for events such as new work orders and bookings, and connections for Slack, Microsoft Teams and SMS. Single sign-on works with any OpenID Connect provider."],
  ["What happens at the end of the trial?", `The trial runs for ${PLANS[TRIAL_PLAN].trialDays} days on the ${PLANS[TRIAL_PLAN].name} plan with no card. If you don’t pick a plan, your workspace becomes read-only: nothing is deleted, and you can export your data.`],
];

// signed-in users go straight to their workspace
export default async function Home() {
  if (await getSession()) redirect("/orgs");
  const demo = process.env.NODE_ENV !== "production" || process.env.SHOW_DEMO_ACCOUNTS === "true";
  const trial = `Start a ${PLANS[TRIAL_PLAN].trialDays}-day trial`;
  const shell = "mx-auto w-full max-w-6xl px-5 sm:px-8";
  return (
    <div className={cn(css.page, "bg-bg text-fg")}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:text-sm">Skip to content</a>
      <div className={css.stage}>
        <header className={cn(shell, "flex items-center justify-between py-5")}>
          <span className="text-white [&_svg]:text-[#8fa2e6]"><span className="hidden sm:inline"><Logo /></span><span className="sm:hidden"><Logo compact /><span className="sr-only">{BRAND.name}</span></span></span>
          <nav aria-label="Main" className="flex items-center gap-1 whitespace-nowrap text-[14px] font-medium sm:gap-2">
            <a href="#how" className="hidden rounded px-3 py-2 text-[#d5dcf5] hover:text-white sm:inline-block">How it works</a>
            <a href="#pricing" className="hidden rounded px-3 py-2 text-[#d5dcf5] hover:text-white sm:inline-block">Pricing</a>
            <Link href="/login" className="rounded px-3 py-2 text-[#d5dcf5] hover:text-white">Sign in</Link>
            <Link href="/register" className="rounded-[var(--radius-md)] bg-white px-3.5 py-2 font-semibold text-[#101736] hover:bg-[#e6eaf8]">Start a trial</Link>
          </nav>
        </header>
        <main id="main">
          <section aria-label="Introduction and interactive preview" className={cn(shell, "pb-16 pt-6 sm:pb-24 sm:pt-10")}>
            <BuildingDemo>
              <h1 className={css.display}>
                <span>Say what happened.</span>
                <span>Read the plan.</span>
                <span>Approve it.</span>
              </h1>
              <p className={cn(css.lede, "mt-7 text-[#cfd6f2]")}>
                {BRAND.name} keeps maintenance, the front desk, amenities, parking and resident requests in one place. Its assistant turns a sentence into a plan you can read, edit and approve, and it never messages a resident without a person saying yes.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/register" className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] bg-[#f6c765] px-5 text-[15px] font-semibold text-[#1b1503] hover:bg-[#f9d484]">{trial}</Link>
                <Link href="/login" className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] border border-white/35 px-5 text-[15px] font-semibold text-white hover:bg-white/10">{demo ? "Sign in to the demo building" : "Sign in"}</Link>
              </div>
              <p className="mt-8 hidden text-[14px] text-[#aab4dd] lg:block">Pick a spot on the building to see what happens next.</p>
            </BuildingDemo>
          </section>
        </main>
      </div>

      <section id="how" aria-labelledby="how-title" className={cn(shell, "py-20 sm:py-28")}>
        <h2 id="how-title" className={cn(css.h2, "max-w-3xl")}>Ask the way you’d ask a colleague.</h2>
        <p className={cn(css.lede, "mb-12 mt-4 text-muted")}>{BRAND.assistantName} works through the same screens and permissions you do. It answers from your records and your documents, and shows you a change before it makes one.</p>
        <AskDemo assistant={BRAND.assistantName} />
      </section>

      <section aria-labelledby="guard-title" className="border-y border-border bg-surface">
        <div className={cn(shell, "grid gap-10 py-20 sm:py-28 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16")}>
          <div>
            <h2 id="guard-title" className={css.h2}>The more an action matters, the more it asks.</h2>
            <p className={cn(css.lede, "mt-4 text-muted")}>Every action the assistant can take belongs to one of five levels. Your organization can make any of them stricter. Only the second can be loosened.</p>
            <p className="mt-6 text-[15px] text-muted">Each step it takes is recorded with who asked, who approved, what changed and when, in an audit log that can’t be edited afterwards.</p>
          </div>
          <ol className={css.ladder}>
            {CLASSES.map(([name, examples, rule], i) => (
              <li key={name} className={css.rung}>
                <span className={css.rungNo} aria-hidden>{i + 1}</span>
                <div>
                  <p className={cn(css.h3, "text-lg")}><span className="sr-only">Level {i + 1}: </span>{name}</p>
                  <p className="mt-0.5 text-[14px] text-muted">{examples}</p>
                  <p className="mt-1.5 text-[14px] font-medium">{rule}</p>
                  <div className={css.meter} aria-hidden><i style={{ width: `${(i + 1) * 20}%` }} /></div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="roles-title" className={cn(shell, "py-20 sm:py-28")}>
        <h2 id="roles-title" className={cn(css.h2, "mb-12 max-w-3xl")}>One building, six different jobs. Each gets its own view.</h2>
        <Roles />
      </section>

      <section aria-labelledby="modules-title" className="border-y border-border bg-surface">
        <div className={cn(shell, "py-20 sm:py-28")}>
          <h2 id="modules-title" className={cn(css.h2, "max-w-3xl")}>Everything a building runs on, already connected.</h2>
          <p className={cn(css.lede, "mt-4 text-muted")}>A failed inspection can open a work order. A work order can notify a vendor. A late vendor shows up on a scorecard. Nothing is copied between tools.</p>
          <dl className="mt-12 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
            {MODULES.map(([name, what]) => (
              <div key={name} className="border-t border-border py-5">
                <dt className={cn(css.h3, "text-[17px]")}>{name}</dt>
                <dd className="mt-1.5 text-[14px] leading-relaxed text-muted">{what}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section aria-labelledby="trust-title" className={cn(shell, "grid gap-10 py-20 sm:py-28 lg:grid-cols-2 lg:gap-16")}>
        <div>
          <h2 id="trust-title" className={css.h2}>Built for records people trust you with.</h2>
          <p className={cn(css.lede, "mt-4 text-muted")}>Resident names, unit numbers, incident reports and access logs are not ordinary data. These are the protections in the product today.</p>
        </div>
        <ul className="text-[15px]">
          {[
            ["Each organization is separated in the database", "Row-level security on every table that holds customer records, checked by automated tests on every change."],
            ["People see what their role covers", "Permissions by organization, property and building, enforced on the server. Custom roles when the built-in ones don’t fit."],
            ["Sign-in you can tighten", "Two-step verification, single sign-on with your identity provider, session lists and remote sign-out."],
            ["An audit log that can’t be rewritten", "Every entry is chained to the one before it, so a change or a gap is detectable."],
            ["Privacy tools included", "Export a person’s data, erase it with legal holds respected, and set how long records are kept."],
          ].map(([t, d]) => (
            <li key={t} className="border-t border-border py-4">
              <p className="font-semibold">{t}</p>
              <p className="mt-1 text-[14px] leading-relaxed text-muted">{d}</p>
            </li>
          ))}
        </ul>
      </section>

      <section id="pricing" aria-labelledby="pricing-title" className="border-y border-border bg-surface">
        <div className={cn(shell, "py-20 sm:py-28")}>
          <h2 id="pricing-title" className={cn(css.h2, "mb-10 max-w-3xl")}>Priced by the units you manage.</h2>
          <Pricing supportEmail={BRAND.supportEmail} />
        </div>
      </section>

      <section aria-labelledby="faq-title" className={cn(shell, "grid gap-10 py-20 sm:py-28 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16")}>
        <h2 id="faq-title" className={css.h2}>Questions people ask first.</h2>
        <div className={css.faq}>
          {FAQ.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p className="max-w-[62ch] pb-6 text-[15px] leading-relaxed text-muted">{a}</p>
            </details>
          ))}
          <div className="border-t border-border" />
        </div>
      </section>

      <section aria-labelledby="cta-title" className={css.stage}>
        <div className={cn(shell, "flex flex-col items-start gap-6 py-16 sm:py-20 md:flex-row md:items-center md:justify-between")}>
          <h2 id="cta-title" className={cn(css.h2, "max-w-xl")}>Walk through a working building before you bring your own.</h2>
          <div className="flex flex-wrap gap-3">
            <Link href="/register" className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] bg-[#f6c765] px-5 text-[15px] font-semibold text-[#1b1503] hover:bg-[#f9d484]">{trial}</Link>
            <Link href="/login" className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] border border-white/35 px-5 text-[15px] font-semibold text-white hover:bg-white/10">{demo ? "Sign in to the demo building" : "Sign in"}</Link>
          </div>
        </div>
      </section>

      <footer className={cn(shell, "flex flex-wrap items-center justify-between gap-4 py-8 text-[13px] text-faint")}>
        <Logo />
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/developers/api" className="underline-offset-2 hover:underline">API reference</Link>
          <a href="#pricing" className="underline-offset-2 hover:underline">Pricing</a>
          <a href={`mailto:${BRAND.supportEmail}`} className="underline-offset-2 hover:underline">{BRAND.supportEmail}</a>
        </nav>
      </footer>
    </div>
  );
}
