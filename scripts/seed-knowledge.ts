import { and, eq } from "drizzle-orm";
import { db, withContext } from "../src/server/db/client";
import { documents, kbSources, properties, users } from "../src/server/db/schema";
import { loadPrincipal } from "../src/server/modules/organizations/principal";
import { createEntry, type EntryInput } from "../src/server/kb/knowledge";
import { processIndexQueue, queueIndex } from "../src/server/kb/indexer";
import type { TenantCtx } from "../src/server/modules/context";

// Knowledge-base entries written the way a property manager would, through the real service (versioned, audited,
// queued), then everything — including the documents seeded earlier — is indexed with the configured embedder.
// Facts here match the seeded amenity rules, vendors and phone numbers, so cited answers agree with the rest of the app.

const PARTY_ROOM = `The Party Room is on level 2 of Tower A and holds up to 40 people.

## Booking
Book in the app at least 48 hours ahead and no more than 90 days ahead. Each unit can hold two bookings within any 30 days. Bookings run between 9 am and 11 pm, for 1 to 5 hours.

## Approval, fee and deposit
Management approves every booking. The fee is $50 and the refundable damage deposit is $250; both are due before the event.

## On the day
Music off by 10:30 pm. Leave the room as you found it: tables wiped, chairs stacked, garbage taken to the P1 room. A cleaning charge comes out of the deposit otherwise. No confetti or glitter.

## Cancelling
Cancel at least 72 hours ahead to get the fee back.`;

const MOVING = `## Book the service elevator
Book the service elevator through the front desk at least 48 hours ahead. Moves are allowed Monday to Saturday, 9 am to 5 pm, for up to 4 hours.

## Deposit and protection
The front desk collects a $200 refundable move deposit. Staff pad the elevator before your move starts.

## After the move
Flatten boxes and take them to the P1 recycling room. Bulky items need a separate pickup — ask the front desk.`;

const FLOOD = `Use this when water is leaking or spreading in a unit or common area outside office hours.

## First 10 minutes
1. Send the on-call technician to the unit. Call 911 first if anyone is hurt or water is near electrical panels.
2. If the leak can't be stopped at the fixture, shut the riser valve for that stack. Tower A risers are in the P1 mechanical room (east wall); Tower B risers are in the P1 mechanical room (west wall).
3. Knock on the units directly below and check for water coming through.

## Then
- Create an emergency work order (plumbing) and assign Blake Plumbing & Heating, who answer 24/7 at 604-555-0142.
- Log an incident (water damage) with photos.
- Tell affected residents through Announcements once the water is off.

## Elevators
If water reaches an elevator shaft, take that car out of service and call Summit Elevator Services at 604-555-0199.`;

const EMERGENCIES = `Call the emergency line, 604-555-0100, instead of only filing a request when:
- water is leaking or flooding and you can't stop it,
- there is no heat in winter, or no power to your unit,
- a door or window that secures your home won't lock,
- an elevator is stuck with someone inside (press the alarm button too).

For fire, smoke or anyone hurt, call 911 first.

Everything else: file a maintenance request in the app. Routine requests are acknowledged within one business day.`;

const HBC_AMENITIES = `## Gym
The gym on P1 is open 5 am to 11 pm. Book up to 3 days ahead, for 30 to 60 minutes at a time. Up to 5 bookings can share a time slot.

## Meeting room
The lobby meeting room seats 10. Book at least 2 hours ahead and up to 30 days out, for 30 minutes to 3 hours, between 8 am and 9 pm. Cancel at least 4 hours ahead.`;

const UNIT_ENTRY = `## Notice
Give residents at least 24 hours' written notice for non-emergency entry, with the reason and a time window between 8 am and 9 pm.

## Emergencies
In an emergency (water, fire, gas) you may enter without notice. Knock, announce yourself, and leave a note saying who entered, when and why.

## While inside
Work in pairs where possible, touch only what the job requires, and record the entry on the work order.`;

const LOUNGE = `The Guest Lounge seats 20. Book it in the app. Keep noise down after 10 pm and clean up before you leave; the strata charges for extra cleaning.`;

async function principalCtx(email: string, slug: string): Promise<TenantCtx> {
  const [u] = await db().select({ id: users.id }).from(users).where(eq(users.email, email));
  const p = u ? await loadPrincipal(u.id, slug) : null;
  if (!p) throw new Error(`seed-knowledge: ${email} is not in ${slug}`);
  return { principal: p, meta: null };
}

const propertyId = async (orgId: string, name: string) => {
  const [p] = await withContext({ orgId, system: true }, (tx) => tx.select({ id: properties.id }).from(properties).where(and(eq(properties.orgId, orgId), eq(properties.name, name))));
  if (!p) throw new Error(`seed-knowledge: no property ${name}`);
  return p.id;
};

export async function seedKnowledge(): Promise<{ entries: number; sources: number; passages: number }> {
  const admin = await principalCtx("admin@demo.test", "pacific-properties");
  const pm = await principalCtx("pm@demo.test", "pacific-properties");
  const ns = await principalCtx("admin@northshore.test", "northshore-strata");
  const frt = await propertyId(admin.principal.orgId, "Fraser Towers");
  const hbc = await propertyId(admin.principal.orgId, "Harbour Centre");
  const entry = (title: string, body: string, rest: Partial<EntryInput>): EntryInput => ({
    title, body, category: "general", audience: "residents", propertyId: null, buildingId: null, notes: null, ...rest,
  });
  const entries: [TenantCtx, EntryInput][] = [
    [pm, entry("Party room booking rules", PARTY_ROOM, { category: "amenities", propertyId: frt })],
    [pm, entry("Moving in and out of Fraser Towers", MOVING, { category: "moving", propertyId: frt })],
    [pm, entry("After-hours flood response — Fraser Towers", FLOOD, { category: "emergency", audience: "staff", propertyId: frt })],
    [pm, entry("Harbour Centre gym and meeting room", HBC_AMENITIES, { category: "amenities", propertyId: hbc })],
    [admin, entry("What counts as a maintenance emergency", EMERGENCIES, { category: "maintenance" })],
    [admin, entry("Entering a resident's unit", UNIT_ENTRY, { category: "procedures", audience: "staff" })],
    [ns, entry("Guest lounge rules", LOUNGE, { category: "amenities" })],
  ];
  for (const [ctx, input] of entries) await createEntry(ctx, input);

  // documents seeded before the knowledge base existed are queued like any upload
  const docs = await withContext({ system: true }, (tx) => tx.select({ id: documents.id, orgId: documents.orgId, version: documents.currentVersion }).from(documents));
  for (const d of docs) await withContext({ orgId: d.orgId, system: true }, (tx) => queueIndex(tx, { orgId: d.orgId, documentId: d.id, version: d.version }));
  for (let i = 0; i < 10 && (await processIndexQueue(100)) > 0; i++);

  const rows = await withContext({ system: true }, (tx) => tx.select({ status: kbSources.status, chunks: kbSources.chunkCount }).from(kbSources));
  return { entries: entries.length, sources: rows.length, passages: rows.reduce((a, r) => a + r.chunks, 0) };
}
