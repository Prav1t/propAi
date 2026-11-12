"use client";
import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { PLANS, PLAN_KEYS, FEATURES, type BillingInterval } from "@/config/plans";
import { formatMoney, monthlyEquivalentCents, quote } from "@/lib/billing";
import css from "./landing.module.css";

/* ── ask in a sentence ── */
const ASKS = [
  { q: "Show me every overdue maintenance request across my properties.", kind: "Looks things up", asks: false,
    does: ["Searches work orders past their due time, only in the properties you manage", "Answers with the actual requests, each one a link"], note: "Reading never needs approval. It can’t see anything you can’t." },
  { q: "Which vendor has been the slowest this month?", kind: "Runs the numbers", asks: false,
    does: ["Runs a query over this month’s completed jobs", "Explains the result and shows the figures it used"], note: "Numbers always come from your records, never from the model’s memory." },
  { q: "What are the rules for reserving the party room?", kind: "Reads your documents", asks: false,
    does: ["Finds the passage in the bylaws and policies you uploaded", "Answers with a link to the page it came from"], note: "If your documents don’t say, it tells you that instead of guessing." },
  { q: "Send residents a message saying the pool will be closed tomorrow.", kind: "Drafts, then asks", asks: true,
    does: ["Drafts the notice in the tone you choose", "Shows who will receive it", "Waits for you to approve, edit or cancel"], note: "Anything that reaches residents or vendors waits for a person by default." },
  { q: "Create an inspection for Building C next Tuesday.", kind: "Prepares the change", asks: true,
    does: ["Picks the building and a matching checklist", "Shows the inspection it is about to create", "Creates it when you approve"], note: "Your organization decides which changes can run without asking." },
];

export function AskDemo({ assistant }: { assistant: string }) {
  const [i, setI] = useState(0);
  const a = ASKS[i];
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-14">
      <div role="tablist" aria-label="Example requests" aria-orientation="vertical">
        {ASKS.map((x, n) => (
          <button key={x.q} type="button" role="tab" id={`ask-${n}`} aria-selected={n === i} aria-controls="ask-panel" onClick={() => setI(n)} className={cn(css.tab, n === i && css.tabOn)}>
            <span>“{x.q}”</span>
          </button>
        ))}
        <div className="border-t border-border" />
      </div>
      <div id="ask-panel" role="tabpanel" aria-labelledby={`ask-${i}`} className="rounded-[14px] border border-border bg-surface p-6 sm:p-7" data-testid="ask-panel">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={cn(css.h3, "text-lg")}>{a.kind}</p>
          <span className={cn("rounded-full px-2.5 py-1 text-[12px] font-semibold", a.asks ? "bg-warning-soft text-warning" : "bg-success-soft text-success")}>{a.asks ? "Waits for your approval" : "Answers straight away"}</span>
        </div>
        <ol className="mt-5 space-y-3">
          {a.does.map((d, n) => (
            <li key={d} className="grid grid-cols-[1.75rem_1fr] gap-2 text-[15px] leading-snug">
              <span className="font-semibold text-accent">{n + 1}.</span><span>{d}</span>
            </li>
          ))}
        </ol>
        <p className="mt-6 border-t border-border pt-4 text-[14px] text-muted">{a.note}</p>
        <p className="mt-2 text-[12px] text-faint">What {assistant} does with this request. Example wording; it understands your own.</p>
      </div>
    </div>
  );
}

/* ── one product, a view for each person ── */
const ROLES = [
  { who: "Property manager", line: "The whole portfolio, in order of what needs you.", can: ["A morning briefing: new requests, overdue work, incidents, what vendors owe you", "An explainable health score for each property, with the data behind it", "Rules like “when an emergency comes in, assign, notify and escalate”", "Reports and CSV exports by property, building and date"] },
  { who: "Front desk", line: "Packages, visitors and questions without leaving one screen.", can: ["Log a package and the resident is told at once", "Guest passes with QR codes, check-in, check-out and visitor parking", "A shift handoff written from what actually happened", "Incident reports with photos, people involved and a timeline"] },
  { who: "Maintenance", line: "Today’s jobs on a phone, with everything needed to finish them.", can: ["My jobs and my tasks, sorted by urgency and due time", "Photos from the camera, checklists, notes and costs", "Preventive maintenance raised automatically from each asset’s schedule", "Inspections with pass or fail, severity and follow-up tasks"] },
  { who: "Resident", line: "An app for the building that installs from the browser.", can: ["Report a problem with photos, even with no signal in the parkade", "Book amenities within the building’s own rules", "Packages, announcements, documents and messages in one place", "Ask a question and get the answer from the building’s own documents"] },
  { who: "Strata council", line: "Meetings and decisions with their paper trail.", can: ["Agendas, motions and votes, with the threshold each motion needs", "Minutes that stop changing once approved", "Bylaws and policies that the assistant can cite", "Read-only views of maintenance, complaints and spending"] },
  { who: "Vendor", line: "Only the jobs assigned to them, nothing else.", can: ["A list of their own work orders", "Schedule, update and complete jobs with notes and photos", "Their licence number and insurance expiry kept with their record", "A scorecard their client sees: response time, on-time rate, cost"] },
];

export function Roles() {
  const [i, setI] = useState(0);
  const r = ROLES[i];
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-14">
      <div role="tablist" aria-label="Who uses it" aria-orientation="vertical">
        {ROLES.map((x, n) => <button key={x.who} type="button" role="tab" id={`role-${n}`} aria-selected={n === i} aria-controls="role-panel" onClick={() => setI(n)} className={cn(css.tab, n === i && css.tabOn)}><span>{x.who}</span></button>)}
        <div className="border-t border-border" />
      </div>
      <div id="role-panel" role="tabpanel" aria-labelledby={`role-${i}`} data-testid="role-panel">
        <p className={cn(css.h3, "text-2xl leading-tight sm:text-3xl")}>{r.line}</p>
        <ul className="mt-6 grid gap-x-10 gap-y-4 sm:grid-cols-2">
          {r.can.map((c) => <li key={c} className="border-t border-border pt-3 text-[15px] leading-snug text-muted">{c}</li>)}
        </ul>
      </div>
    </div>
  );
}

/* ── pricing, from the same plan configuration the product bills with ── */
export function Pricing({ supportEmail }: { supportEmail: string }) {
  const [units, setUnits] = useState(180);
  const [interval, setInterval] = useState<BillingInterval>("month");
  // the smallest plan whose unit limit holds this portfolio
  const fit = PLAN_KEYS.find((k) => PLANS[k].limits.units === null || units <= PLANS[k].limits.units!) ?? "enterprise";
  return (
    <div>
      <div className="grid items-end gap-6 sm:grid-cols-[1fr_auto]">
        <div>
          <label htmlFor="units" className="flex items-baseline justify-between gap-4 text-[15px] font-semibold">
            <span>How many units do you manage?</span>
            <output htmlFor="units" className={cn(css.price, "!text-2xl")} data-testid="unit-count">{units.toLocaleString("en-CA")}</output>
          </label>
          <input id="units" type="range" min={10} max={6000} step={10} value={units} onChange={(e) => setUnits(Number(e.target.value))} className={css.range} />
        </div>
        <div role="group" aria-label="Billing period" className="inline-flex rounded-[var(--radius-md)] border border-border-strong p-0.5 text-[13px] font-semibold">
          {(["month", "year"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={interval === v} onClick={() => setInterval(v)} className={cn("min-h-9 rounded-[5px] px-3", interval === v ? "bg-fg text-bg" : "text-muted hover:text-fg")}>
              {v === "month" ? "Monthly" : "Yearly, 2 months free"}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-10 grid gap-10 md:grid-cols-3 md:gap-8">
        {PLAN_KEYS.map((k) => {
          const p = PLANS[k];
          const over = p.limits.units !== null && units > p.limits.units;
          const perMonth = monthlyEquivalentCents(p, interval, units);
          return (
            <div key={k} className={cn(css.plan, k === fit && css.planFit)} data-testid={`plan-${k}`}>
              <div className="flex items-center justify-between gap-2">
                <h3 className={cn(css.h3, "text-xl")}>{p.name}</h3>
                {k === fit ? <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-semibold text-accent">Fits {units.toLocaleString("en-CA")} units</span> : null}
              </div>
              <p className="mt-1 min-h-10 text-[14px] text-muted">{p.tagline}</p>
              {over ? (
                <p className="mt-4 min-h-[4.25rem] text-[14px] text-faint">Holds up to {p.limits.units!.toLocaleString("en-CA")} units.</p>
              ) : (
                <div className="mt-4 min-h-[4.25rem]">
                  <p className={css.price} data-testid={`price-${k}`}>{formatMoney(perMonth, p.currency)}</p>
                  <p className="mt-1 text-[13px] text-faint">{p.currency} a month{interval === "year" ? `, billed ${formatMoney(quote(p, "year", units).totalCents, p.currency)} a year` : ""}</p>
                </div>
              )}
              <ul className="mt-5 space-y-2 text-[14px]">
                <li>{p.limits.properties === null ? "Unlimited properties" : `Up to ${p.limits.properties} properties`}</li>
                <li>{p.limits.staff_seats === null ? "Unlimited staff seats" : `${p.limits.staff_seats} staff seats`}, residents free</li>
                <li>{p.limits.ai_requests!.toLocaleString("en-CA")} assistant requests a month</li>
                {(Object.keys(FEATURES) as (keyof typeof FEATURES)[]).filter((f) => f !== "ai_assistant").map((f) => (
                  <li key={f} className={p.features.includes(f) ? "" : "text-faint line-through decoration-1"}>{FEATURES[f].label}{p.features.includes(f) ? "" : <span className="sr-only"> (not included)</span>}</li>
                ))}
              </ul>
              <div className="mt-6">
                {k === "enterprise"
                  ? <a href={`mailto:${supportEmail}?subject=Enterprise%20plan`} className="inline-flex min-h-10 items-center rounded-[var(--radius-md)] border border-border-strong px-4 text-sm font-semibold hover:bg-subtle">Talk to us</a>
                  : <Link href="/register" className={cn("inline-flex min-h-10 items-center rounded-[var(--radius-md)] px-4 text-sm font-semibold", k === fit ? "bg-accent text-accent-fg hover:opacity-90" : "border border-border-strong hover:bg-subtle")}>Start a {p.trialDays}-day trial</Link>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-8 text-[13px] text-faint">Each plan includes a number of units ({PLAN_KEYS.map((k) => `${PLANS[k].name} ${PLANS[k].includedUnits.toLocaleString("en-CA")}`).join(", ")}); units above that are {PLAN_KEYS.map((k) => `${formatMoney(PLANS[k].perUnitMonthlyCents, PLANS[k].currency)}`).join(" / ")} each a month. The trial runs on Professional and needs no card.</p>
    </div>
  );
}
