# Demo script

A 20-minute walk through the product for a prospective customer, using the seeded demo organization (Pacific Properties Management). Every step below uses a real feature on real seeded records; nothing is staged.

## Before the meeting

1. **Rebrand.** Replace the placeholder names in `src/config/brand.ts` and rebuild. A demo that says "[YOUR PRODUCT NAME]" undoes the rest.
2. **Reseed the same day:** `npm run db:reset`. The demo data is dated relative to the moment it is seeded (today's incidents, this week's bookings, the shift happening now). A database seeded last week shows almost everything overdue.
3. **Decide about the assistant.** Without a model key it runs in **demo mode**: it is labelled, understands a fixed set of phrasings (the ones below), and uses the same tools, permissions and approvals as with a model. With `AI_PROVIDER`, `AI_MODEL` and a key set, free-form questions work. Say which one the audience is seeing.
4. **Open two browser windows:** one for the manager, one private window for the resident. Password for every demo account: `DemoPass!2026`.
5. **Do a dry run.** Ten minutes, alone, the same day.

## The walk

| # | Minutes | Who | Show | Say |
|---|---|---|---|---|
| 1 | 2 | Nobody signed in | The landing page. Click *Leak in 1204* on the building, then *Elevator* and **Approve the plan** | "Something happens in a building. The product writes the plan. A person approves what matters." It is a preview with sample data; the next steps are the real thing |
| 2 | 3 | `resident@demo.test` (phone-sized window) | *Report a problem*: "My kitchen sink is leaking badly and water is spreading across the floor", add a photo, submit | The resident sees a tracked request at once. On a phone this works offline and can be installed |
| 3 | 3 | `pm@demo.test` | Dashboard → the new request is there, already categorised as plumbing and prioritised by the property's triage rules. Open it, assign Blake Plumbing & Heating | Triage follows rules the customer sets, not a guess. The SLA clock is running |
| 4 | 4 | `pm@demo.test` | *Assistant*: "Show me all overdue maintenance requests across my properties", then "Which vendor has been the slowest this month?" | Answers come from records this manager may see, with links. Numbers come from queries, never from the model |
| 5 | 3 | `pm@demo.test` | *Assistant*: "Send residents of Fraser Towers a notice saying the pool will be closed tomorrow". Show the plan card: recipients, draft, **Edit**, **Approve** | Nothing reaches a resident without a person approving it. Every step is in the audit log, marked as assistant-made |
| 6 | 2 | `pm@demo.test` | *Automations → Waiting for approval*: the elevator emergency. Open the rule's flow view | When this happens, if these conditions hold, do that, with an approval step where they want one |
| 7 | 2 | `concierge@demo.test` | *Front desk*: log a package for a unit; check a visitor in | The resident is notified; the shift handoff writes itself from what happened |
| 8 | 1 | `resident@demo.test` | *Assistant*: "What are the rules for booking the party room?" | The answer quotes the building's own documents and links the source |
| 9 | 2 | `pm@demo.test` | *Analytics*: a property's health score → *How it's calculated* | The score shows its working: each factor, its weight and the records behind it |
| 10 | 1 | `admin@demo.test` | *Settings → Security* and *Audit log* (verify the chain) | Two-step verification, single sign-on, session control, and an audit log that can't be rewritten |

## Questions to expect, and straight answers

- **"Is this live with customers?"** No. It is a complete, tested product that has not yet run in production. Say so.
- **"Is it secure?"** Tenant separation is enforced in the database and tested on every change; there is a written threat model and a production checklist. It has not had an independent penetration test. Offer one as part of a pilot.
- **"Which AI?"** Their choice of model provider, or a self-hosted model. Tell them what is sent to it: the question, the person's role, and the records the tools return for that person.
- **"Can it integrate with our accounting system?"** There is a REST API and signed webhooks. There is no ready-made connector for Yardi, QuickBooks or Xero yet.
- **"Does it take rent payments?"** It tracks them; it doesn't collect them. Leases, monthly rent charges and recorded payments are built (*Leases*, as `admin@demo.test`: Kingsway Residences has 35 leases, some with rent overdue). Online payment, listings and applications are not.
- **"Can our council vote in it?"** Yes: as `council@demo.test` open *Meetings*, the meeting this month has two motions open. It records votes and applies the threshold set on each motion; it doesn't decide which threshold the law requires.
- **"What does it cost?"** The pricing on the landing page is the configuration the product bills with. It is a starting proposal, not a tested price: change `src/config/plans.ts`.
- **"Is it accessible?"** Automated WCAG 2.2 AA checks pass on every page for every role. It has not been tested with screen readers by people who use them.

## What not to show yet

- Paying through Stripe (tested against fixtures, not a real Stripe account).
- Push notifications on a real phone (tested against a local receiver).
- Parking camera detection beyond the one seeded example: there is a review workflow for detections, but no vision model is connected.
