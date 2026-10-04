import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as s from "../src/server/db/schema";

type Tx = Parameters<Parameters<NodePgDatabase<typeof s>["transaction"]>[0]>[0];

// deterministic PRNG (separate stream from the portfolio seed)
function rng(seed: number) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const H = 3_600_000;
const D = 24 * H;

// realistic maintenance, tasks, inspections, incidents and complaints for the demo org
export async function seedOps(tx: Tx, orgId: string, now = new Date()) {
  const rand = rng(424242);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)];
  const between = (a: number, b: number) => a + rand() * (b - a);

  const props = await tx.select().from(s.properties).where(eq(s.properties.orgId, orgId));
  const P = (code: string) => props.find((p) => p.code === code)!;
  const blds = await tx.select().from(s.buildings).where(eq(s.buildings.orgId, orgId));
  const allUnits = await tx.select().from(s.units).where(and(eq(s.units.orgId, orgId), eq(s.units.type, "residential")));
  const vend = await tx.select().from(s.vendors).where(eq(s.vendors.orgId, orgId));
  const V = (name: string) => vend.find((v) => v.name.startsWith(name))!;
  const approvals = await tx.select().from(s.vendorProperties).where(eq(s.vendorProperties.orgId, orgId));
  const mem = await tx.select({ id: s.memberships.id, email: s.users.email, userId: s.users.id }).from(s.memberships)
    .innerJoin(s.users, eq(s.users.id, s.memberships.userId)).where(eq(s.memberships.orgId, orgId));
  const M = (email: string) => mem.find((m) => m.email === email)!;
  const occ = await tx.select({ unitId: s.unitOccupancies.unitId, residentId: s.unitOccupancies.residentId, userId: s.residents.userId })
    .from(s.unitOccupancies).innerJoin(s.residents, eq(s.residents.id, s.unitOccupancies.residentId))
    .where(and(eq(s.unitOccupancies.orgId, orgId), sql`${s.unitOccupancies.endsOn} is null`));
  const admin = M("admin@demo.test");
  const pm = M("pm@demo.test");
  const tech = M("staff@demo.test");
  const concierge = M("concierge@demo.test");
  const facility = M("facility@demo.test");
  const emma = M("resident@demo.test");

  /* ── SLA + triage configuration ── */
  await tx.insert(s.slaPolicies).values([
    { orgId, priority: "urgent", respondMinutes: 60, resolveMinutes: 24 * 60 },
    { orgId, priority: "high", respondMinutes: 4 * 60, resolveMinutes: 3 * 24 * 60 },
    { orgId, priority: "normal", respondMinutes: 24 * 60, resolveMinutes: 7 * 24 * 60 },
    { orgId, priority: "low", respondMinutes: 3 * 24 * 60, resolveMinutes: 14 * 24 * 60 },
    { orgId, propertyId: P("HBC").id, priority: "urgent", respondMinutes: 30, resolveMinutes: 12 * 60 },
  ]);
  await tx.insert(s.triageRules).values([
    { orgId, name: "Spreading water / flooding", position: 10, keywords: ["flooding", "flood", "burst pipe", "water spreading", "spreading", "ceiling leak", "water everywhere"], setEmergency: true,
      residentInstructions: "If water is spreading: shut off the valve under the sink or behind the toilet, move valuables off the floor, and call the 24/7 emergency line at 604-555-0100." },
    { orgId, name: "Leaks go to plumbing", position: 20, keywords: ["leak", "leaking", "drip", "dripping", "clogged", "backed up"], setPriority: "high", setCategory: "plumbing", assignVendorId: V("Blake").id },
    { orgId, name: "Smoke, gas or sparks", position: 5, keywords: ["smoke", "gas smell", "smell gas", "sparks", "burning smell", "fire alarm"], setEmergency: true, setCategory: "fire_safety",
      residentInstructions: "If you smell gas or see smoke or fire, leave the unit and call 911 first. Then call the building's emergency line at 604-555-0100." },
    { orgId, name: "Elevators", position: 30, category: "elevator", keywords: [], setPriority: "high", assignVendorId: V("Summit").id },
    { orgId, name: "Elevator keywords", position: 31, keywords: ["elevator", "lift"], setCategory: "elevator", setPriority: "high", assignVendorId: V("Summit").id },
    { orgId, name: "No heat", position: 40, keywords: ["no heat", "furnace", "heater not working", "freezing"], setPriority: "high", setCategory: "hvac" },
    { orgId, name: "Electrical", position: 50, category: "electrical", keywords: [], assignVendorId: V("Coastline").id },
    { orgId, name: "Pests", position: 60, category: "pest", keywords: [], assignVendorId: V("Pacific Pest").id },
    { orgId, name: "Lockouts", position: 70, keywords: ["locked out", "lost key", "lost fob"], setPriority: "high", setCategory: "doors_locks",
      residentInstructions: "If you're locked out, the front desk can let you in after verifying your ID." },
  ]);

  /* ── work orders ── */
  const TEMPLATES: { cat: string; titles: string[]; desc: string[]; vendor?: string; prio?: string }[] = [
    { cat: "plumbing", vendor: "Blake", prio: "high", titles: ["Kitchen sink leaking", "Bathroom faucet dripping", "Toilet running constantly", "Shower drain clogged", "Low water pressure"], desc: ["Started this morning.", "Getting worse over the past few days.", "There's a puddle under the cabinet."] },
    { cat: "hvac", vendor: "Blake", titles: ["Heat not working in bedroom", "AC unit making loud noise", "Thermostat unresponsive", "Vent rattling"], desc: ["Unit is cold even with thermostat at 23°C.", "Noise is worse at night."] },
    { cat: "electrical", vendor: "Coastline", titles: ["Outlet not working in living room", "Hallway light flickering", "Breaker keeps tripping", "Bathroom fan not working"], desc: ["Tried resetting the breaker.", "Happens when the microwave runs."] },
    { cat: "appliance", titles: ["Dishwasher not draining", "Fridge not cooling", "Oven element broken", "Washer leaking during spin"], desc: ["Model number on the inside door.", "Food is going bad."] },
    { cat: "elevator", vendor: "Summit", prio: "high", titles: ["Elevator out of service", "Elevator door not closing properly", "Elevator stopping between floors"], desc: ["Residents on upper floors affected.", "Reported by several residents."] },
    { cat: "doors_locks", titles: ["Unit door lock sticking", "Fob not working at parkade gate", "Lobby door not latching"], desc: ["Have to jiggle it several times.", "Security concern overnight."] },
    { cat: "pest", vendor: "Pacific Pest", titles: ["Ants in kitchen", "Mice droppings in storage room", "Cockroach sighting"], desc: ["Seen near the pantry.", "Second time this month."] },
    { cat: "cleaning", vendor: "Pristine", prio: "low", titles: ["Spill in elevator lobby", "Garbage room needs cleaning", "Carpet stain in hallway"], desc: ["Near the east stairwell."] },
    { cat: "exterior", prio: "low", titles: ["Loose railing on balcony", "Window seal damaged", "Gutter overflowing"], desc: ["Water coming in during rain."] },
    { cat: "fire_safety", vendor: "Firewise", prio: "high", titles: ["Smoke detector beeping", "Fire extinguisher missing from cabinet", "Emergency exit sign light out"], desc: ["Chirping every minute.", "Floor 6 east stairwell."] },
  ];
  const statusesByAge = (ageDays: number): string => {
    const r = rand();
    if (ageDays > 30) return r < 0.85 ? "closed" : r < 0.93 ? "completed" : "cancelled";
    if (ageDays > 10) return r < 0.55 ? "closed" : r < 0.75 ? "completed" : r < 0.85 ? "in_progress" : r < 0.93 ? "awaiting_vendor" : "scheduled";
    if (ageDays > 3) return r < 0.3 ? "completed" : r < 0.5 ? "in_progress" : r < 0.65 ? "scheduled" : r < 0.8 ? "assigned" : r < 0.9 ? "awaiting_resident" : "acknowledged";
    return r < 0.1 ? "completed" : r < 0.3 ? "in_progress" : r < 0.5 ? "assigned" : r < 0.7 ? "acknowledged" : "new";
  };
  const SLA: Record<string, [number, number]> = { urgent: [1, 24], high: [4, 72], normal: [24, 168], low: [72, 336] };
  const woRows: (typeof s.workOrders.$inferInsert)[] = [];
  const events: (typeof s.timelineEvents.$inferInsert)[] = [];
  let number = 0;
  const approved = (vendorId: string, propertyId: string) => approvals.some((a) => a.vendorId === vendorId && a.propertyId === propertyId);
  const residentUnits = allUnits.filter((u) => occ.some((o) => o.unitId === u.id));

  // staff-submitted requests come from someone whose scope covers the property
  const staffSubmitter = (propertyId: string) =>
    propertyId === P("FRT").id ? pick([pm.userId, concierge.userId, admin.userId]) : propertyId === P("HBC").id ? pick([pm.userId, admin.userId]) : admin.userId;
  for (let i = 0; i < 170; i++) {
    const t = pick(TEMPLATES);
    const unit = pick(residentUnits);
    const ageDays = Math.pow(rand(), 1.6) * 90;
    const createdAt = new Date(now.getTime() - ageDays * D);
    const emergency = t.cat === "plumbing" && rand() < 0.08;
    const priority = emergency ? "urgent" : t.prio ?? pick(["normal", "normal", "normal", "low", "high"]);
    const rawStatus = statusesByAge(ageDays);
    const [respH, resolveH] = SLA[priority];
    const resident = occ.find((o) => o.unitId === unit.id);
    const vendor = t.vendor ? V(t.vendor) : null;
    const useVendor = vendor && approved(vendor.id, unit.propertyId) && rand() < 0.8;
    const isHbc = unit.propertyId === P("HBC").id;
    const assignee = !useVendor && isHbc && rand() < 0.7 ? tech.id : null;
    // work in an "assigned"-or-later state always has someone on it; otherwise it's still in triage
    const inWork = ["assigned", "scheduled", "in_progress", "awaiting_vendor", "awaiting_resident"].includes(rawStatus);
    const status = inWork && !assignee && !useVendor ? "acknowledged" : rawStatus;
    const assigned = status !== "new" && status !== "acknowledged" && status !== "cancelled";
    const firstResponseAt = status === "new" ? null : new Date(createdAt.getTime() + between(0.1, respH * 1.6) * H);
    const onTime = rand() < 0.82;
    const completedAt = ["completed", "closed"].includes(status) ? new Date(createdAt.getTime() + (onTime ? between(0.2, 0.95) : between(1.05, 2.2)) * resolveH * H) : null;
    const cappedCompleted = completedAt && completedAt > now ? new Date(now.getTime() - between(1, 12) * H) : completedAt;
    number++;
    const id = crypto.randomUUID();
    const fromResident = rand() < 0.7;
    woRows.push({
      id, orgId, number, propertyId: unit.propertyId, buildingId: unit.buildingId, unitId: t.cat === "elevator" || t.cat === "cleaning" ? null : unit.id,
      area: t.cat === "elevator" ? "Elevator bank" : t.cat === "cleaning" ? "Common area" : null,
      category: t.cat, priority, isEmergency: emergency, title: emergency ? "Water spreading from under kitchen sink" : pick(t.titles), description: pick(t.desc),
      status, source: fromResident ? "resident" : "staff", submittedByUserId: fromResident ? (resident?.userId ?? null) : staffSubmitter(unit.propertyId),
      residentId: fromResident ? resident?.residentId ?? null : null,
      assignedMembershipId: assigned ? assignee : null, vendorId: assigned && useVendor ? vendor!.id : null,
      permissionToEnter: rand() < 0.6, respondDueAt: new Date(createdAt.getTime() + respH * H), resolveDueAt: new Date(createdAt.getTime() + resolveH * H),
      firstResponseAt, completedAt: cappedCompleted, closedAt: status === "closed" ? new Date((cappedCompleted ?? createdAt).getTime() + between(2, 72) * H) : null,
      cancelledAt: status === "cancelled" ? new Date(createdAt.getTime() + between(1, 48) * H) : null,
      ...(() => { const st = status === "scheduled" ? new Date(now.getTime() + between(4, 96) * H) : null; return { scheduledStart: st, scheduledEnd: st ? new Date(st.getTime() + 2 * H) : null }; })(),
      cost: cappedCompleted ? (vendor && useVendor ? between(90, 1400) : between(0, 180)).toFixed(2) : null,
      resolutionNotes: cappedCompleted ? pick(["Replaced faulty part and tested.", "Cleared blockage; running normally.", "Repaired and confirmed with resident.", "Adjusted and lubricated; no further issues."]) : null,
      slaBreachedAt: null, createdAt, updatedAt: createdAt,
    });
    events.push({ orgId, entityType: "work_order", entityId: id, kind: "created", toStatus: "new", visibility: "public", body: `Request #${number} submitted.`, createdAt });
    if (assigned && (assignee || useVendor)) events.push({ orgId, entityType: "work_order", entityId: id, kind: "assigned", visibility: "vendor", actorUserId: pm.userId, body: `Assigned to ${useVendor ? vendor!.name : "Luis Moreno"}.`, createdAt: firstResponseAt ?? createdAt });
    if (status !== "new") events.push({ orgId, entityType: "work_order", entityId: id, kind: "status", fromStatus: "new", toStatus: status, visibility: "public", actorUserId: pm.userId, createdAt: cappedCompleted ?? firstResponseAt ?? createdAt });
  }
  // hand-picked demo scenarios
  const towerB = blds.find((b) => b.code === "B" && b.propertyId === P("FRT").id)!;
  const emmaUnit = occ.find((o) => o.userId === emma.userId)!;
  const demo = [
    { title: "Tower B elevator out of service", category: "elevator", priority: "urgent", status: "assigned", area: "Elevator bank", unitId: null, buildingId: towerB.id, propertyId: P("FRT").id, vendorId: V("Summit").id, age: 5 * H, desc: "Car 2 stuck on level 9 with doors open. Residents above level 10 are using the stairs." },
    { title: "Bathroom fan not working", category: "electrical", priority: "normal", status: "scheduled", area: null, unitId: emmaUnit.unitId, buildingId: towerB.id, propertyId: P("FRT").id, vendorId: V("Coastline").id, age: 2 * D, desc: "Fan doesn't turn on at all.", resident: true },
    { title: "Kitchen faucet dripping", category: "plumbing", priority: "high", status: "closed", area: null, unitId: emmaUnit.unitId, buildingId: towerB.id, propertyId: P("FRT").id, vendorId: V("Blake").id, age: 40 * D, desc: "Constant drip from the kitchen tap.", resident: true },
    { title: "Parkade gate not closing", category: "doors_locks", priority: "high", status: "new", area: "P1 parkade gate", unitId: null, buildingId: blds.find((b) => b.propertyId === P("HBC").id)!.id, propertyId: P("HBC").id, vendorId: null, age: 26 * H, desc: "Gate stays open after cars pass — security risk overnight." },
  ];
  for (const d of demo) {
    number++;
    const id = crypto.randomUUID();
    const createdAt = new Date(now.getTime() - d.age);
    const [respH, resolveH] = SLA[d.priority];
    woRows.push({
      id, orgId, number, propertyId: d.propertyId, buildingId: d.buildingId, unitId: d.unitId, area: d.area, category: d.category, priority: d.priority,
      title: d.title, description: d.desc, status: d.status, source: d.resident ? "resident" : "staff",
      submittedByUserId: d.resident ? emma.userId : pm.userId, residentId: d.resident ? emmaUnit.residentId : null, vendorId: d.vendorId,
      respondDueAt: new Date(createdAt.getTime() + respH * H), resolveDueAt: new Date(createdAt.getTime() + resolveH * H),
      firstResponseAt: d.status === "new" ? null : new Date(createdAt.getTime() + 0.5 * H),
      completedAt: d.status === "closed" ? new Date(createdAt.getTime() + 30 * H) : null, closedAt: d.status === "closed" ? new Date(createdAt.getTime() + 40 * H) : null,
      scheduledStart: d.status === "scheduled" ? new Date(now.getTime() + 26 * H) : null, scheduledEnd: d.status === "scheduled" ? new Date(now.getTime() + 28 * H) : null,
      cost: d.status === "closed" ? "145.00" : null, resolutionNotes: d.status === "closed" ? "Replaced cartridge and O-rings." : null,
      permissionToEnter: !!d.resident, createdAt, updatedAt: createdAt,
    });
    events.push({ orgId, entityType: "work_order", entityId: id, kind: "created", toStatus: "new", visibility: "public", body: `Request #${number} submitted.`, actorUserId: d.resident ? emma.userId : pm.userId, createdAt });
    if (d.vendorId) events.push({ orgId, entityType: "work_order", entityId: id, kind: "assigned", visibility: "vendor", actorUserId: pm.userId, body: `Assigned to ${vend.find((v) => v.id === d.vendorId)!.name}.`, createdAt: new Date(createdAt.getTime() + 0.5 * H) });
    if (d.status !== "new") events.push({ orgId, entityType: "work_order", entityId: id, kind: "status", fromStatus: "new", toStatus: d.status, visibility: "public", actorUserId: pm.userId, createdAt: new Date(createdAt.getTime() + 0.6 * H) });
    if (d.status === "scheduled") events.push({ orgId, entityType: "work_order", entityId: id, kind: "comment", visibility: "public", actorUserId: pm.userId, body: "Coastline will visit tomorrow afternoon. Permission to enter is on file.", createdAt: new Date(createdAt.getTime() + H) });
  }
  // flag overdue open orders as already breached (as the SLA monitor would have)
  for (const w of woRows) if (["new", "acknowledged", "assigned", "scheduled", "in_progress", "awaiting_vendor", "awaiting_resident"].includes(w.status!) && (w.resolveDueAt as Date) < now) w.slaBreachedAt = w.resolveDueAt as Date;
  for (let i = 0; i < woRows.length; i += 100) await tx.insert(s.workOrders).values(woRows.slice(i, i + 100));
  for (let i = 0; i < events.length; i += 200) await tx.insert(s.timelineEvents).values(events.slice(i, i + 200));
  await tx.insert(s.orgCounters).values({ orgId, key: "work_order", value: number });

  /* ── tasks ── */
  const taskSeed: { title: string; prop: string | null; who: { id: string }; due: number; rec?: string; status?: string; prio?: string; list?: string[] }[] = [
    { title: "Weekly generator test", prop: "HBC", who: tech, due: 2, rec: "weekly", list: ["Run generator 30 min under load", "Check fuel level", "Log readings"] },
    { title: "Monthly fire extinguisher check", prop: "HBC", who: tech, due: 9, rec: "monthly", list: ["Check pressure gauges", "Inspect tags", "Replace missing units"] },
    { title: "Lobby deep clean", prop: "FRT", who: concierge, due: 1, rec: "weekly" },
    { title: "Replace burnt-out parkade lights (P2)", prop: "HBC", who: tech, due: -3, prio: "high" },
    { title: "Order replacement fobs", prop: "FRT", who: concierge, due: 4 },
    { title: "Review HVAC quote from Blake", prop: "FRT", who: facility, due: 6, prio: "high" },
    { title: "Schedule annual elevator certification", prop: "FRT", who: facility, due: 14 },
    { title: "Post water shut-off notice (Thursday)", prop: "HBC", who: pm, due: 0, status: "in_progress" },
    { title: "Prepare Q3 maintenance report for owners", prop: null, who: admin, due: 10 },
    { title: "Follow up on parkade gate repair quote", prop: "HBC", who: pm, due: -1, prio: "high" },
    { title: "Repaint stairwell handrails", prop: "HBC", who: tech, due: -10, status: "done" },
    { title: "Test emergency lighting", prop: "FRT", who: facility, due: -20, status: "done", rec: "none" },
  ];
  for (const t of taskSeed) {
    const [row] = await tx.insert(s.tasks).values({
      orgId, propertyId: t.prop ? P(t.prop).id : null, title: t.title, priority: t.prio ?? "normal", status: t.status ?? "open",
      dueAt: new Date(now.getTime() + t.due * D), assignedMembershipId: t.who.id, createdByUserId: pm.userId, recurrence: t.rec ?? "none",
      completedAt: t.status === "done" ? new Date(now.getTime() + (t.due + 1) * D) : null, createdAt: new Date(now.getTime() - 14 * D),
    }).returning();
    if (t.list) await tx.insert(s.taskChecklistItems).values(t.list.map((label, i) => ({ orgId, taskId: row.id, label, position: i, done: i === 0 && t.due < 3 })));
  }

  /* ── inspections ── */
  const tpl = await tx.insert(s.inspectionTemplates).values([
    { orgId, name: "Move-in / move-out unit inspection", kind: "move_in", items: [
      ["Entry", "Door, lock and peephole"], ["Entry", "Walls and flooring"], ["Kitchen", "Appliances working"], ["Kitchen", "Sink and faucet"], ["Kitchen", "Cabinets and counters"],
      ["Bathroom", "Toilet and flushing"], ["Bathroom", "Shower/tub and caulking"], ["Bathroom", "Exhaust fan"], ["Living", "Windows and blinds"], ["Living", "Smoke detector"], ["Bedroom", "Closet doors"], ["Bedroom", "Outlets and lights"],
    ].map(([section, label]) => ({ section, label })) },
    { orgId, name: "Monthly fire & life safety walk", kind: "safety", repeatEveryDays: 30, items: [
      ["Exits", "Exit signs illuminated"], ["Exits", "Stairwells clear"], ["Equipment", "Extinguishers charged and tagged"], ["Equipment", "Fire panel normal"], ["Equipment", "Sprinkler valves open"], ["Lighting", "Emergency lights tested"],
    ].map(([section, label]) => ({ section, label })) },
    { orgId, name: "Quarterly elevator machine room", kind: "equipment", repeatEveryDays: 90, items: [
      ["Room", "Room clean and locked"], ["Room", "Temperature within range"], ["Machine", "No oil leaks"], ["Machine", "Logbook up to date"],
    ].map(([section, label]) => ({ section, label })) },
  ]).returning();
  const hbcMain = blds.find((b) => b.propertyId === P("HBC").id)!;
  const inspSeed = [
    { t: tpl[1], b: hbcMain, days: -35, status: "completed", fail: [] as number[], who: tech },
    { t: tpl[1], b: hbcMain, days: -5, status: "completed", fail: [2, 5], who: tech },
    { t: tpl[1], b: hbcMain, days: 25, status: "scheduled", fail: [], who: tech },
    { t: tpl[1], b: towerB, days: -3, status: "scheduled", fail: [], who: facility },
    { t: tpl[2], b: towerB, days: -60, status: "completed", fail: [2], who: facility },
    { t: tpl[2], b: towerB, days: 6, status: "scheduled", fail: [], who: facility },
    { t: tpl[0], b: towerB, days: 2, status: "scheduled", fail: [], who: concierge, unit: "905" },
    { t: tpl[0], b: hbcMain, days: -12, status: "completed", fail: [6], who: tech, unit: "704" },
  ];
  for (const x of inspSeed) {
    const unit = x.unit ? allUnits.find((u) => u.buildingId === x.b.id && u.number === x.unit) : undefined;
    const date = new Date(now.getTime() + x.days * D).toISOString().slice(0, 10);
    const done = x.status === "completed";
    const [ins] = await tx.insert(s.inspections).values({
      orgId, templateId: x.t.id, propertyId: x.b.propertyId, buildingId: x.b.id, unitId: unit?.id ?? null, kind: x.t.kind,
      title: `${x.t.name}${unit ? ` — Unit ${unit.number}` : ` — ${x.b.name}`}`, scheduledFor: date, status: x.status, inspectorMembershipId: x.who.id,
      result: done ? (x.fail.length ? "fail" : "pass") : null, signedByName: done ? "Luis Moreno" : null, completedAt: done ? new Date(now.getTime() + x.days * D + 3 * H) : null,
      summary: done ? (x.fail.length ? "Deficiencies noted; follow-ups created." : "All items in order.") : null,
    }).returning();
    await tx.insert(s.inspectionItems).values(x.t.items.map((it, n) => ({
      orgId, inspectionId: ins.id, section: it.section, label: it.label, position: n,
      result: done ? (x.fail.includes(n) ? "fail" : "pass") : null, severity: done && x.fail.includes(n) ? pick(["medium", "high"]) : null,
      notes: done && x.fail.includes(n) ? pick(["Needs replacement.", "Tag expired last month.", "Caulking cracked and mouldy."]) : null,
    })));
  }

  /* ── incidents ── */
  const INC = [
    { type: "water_damage", sev: "high", title: "Water leak from unit above into ceiling", status: "resolved", days: 18, prop: "HBC", res: "Plumber fixed supply line in unit above; drywall repaired." },
    { type: "security", sev: "medium", title: "Tailgating at parkade gate", status: "investigating", days: 2, prop: "HBC" },
    { type: "unauthorized_access", sev: "high", title: "Unknown person found in bike room", status: "open", days: 1, prop: "FRT" },
    { type: "equipment_failure", sev: "high", title: "Tower B elevator car 2 stopped between floors", status: "investigating", days: 0.2, prop: "FRT" },
    { type: "injury", sev: "medium", title: "Resident slipped on wet lobby floor", status: "resolved", days: 25, prop: "FRT", res: "Wet-floor signage procedure reinforced with cleaning contractor." },
    { type: "resident", sev: "low", title: "Noise disturbance after midnight", status: "closed", days: 30, prop: "KWR", res: "Resident spoken to; no repeat." },
    { type: "fire", sev: "critical", title: "Smoke in garbage chute room", status: "closed", days: 45, prop: "PCH", res: "Fire department attended; smouldering cardboard. Chute cleaned." },
    { type: "property_damage", sev: "medium", title: "Vandalism to mailbox panel", status: "open", days: 4, prop: "KWR" },
    { type: "security", sev: "low", title: "Package theft reported from lobby", status: "investigating", days: 6, prop: "FRT" },
    { type: "water_damage", sev: "medium", title: "Sprinkler head leak in P1 parkade", status: "resolved", days: 12, prop: "HBC", res: "Firewise replaced sprinkler head." },
    { type: "equipment_failure", sev: "medium", title: "Boiler pressure alarm overnight", status: "closed", days: 20, prop: "PCH", res: "Pressure reset by on-call tech; monitoring." },
    { type: "other", sev: "low", title: "Lost dog in courtyard", status: "closed", days: 9, prop: "KWR", res: "Owner located." },
    // earlier today, so "summarize today's incidents" has something real to summarize
    { type: "water_damage", sev: "medium", title: "Water pooling at P2 parkade ramp", status: "open", days: 0.03, prop: "HBC", loc: "Parkade P2" },
    { type: "security", sev: "low", title: "Lobby door propped open during a move", status: "resolved", days: 0.05, prop: "FRT", res: "Door closed; the moving company was reminded of the move-in policy.", loc: "Lobby" },
  ];
  let incNo = 0;
  const staffUsers = [concierge.userId, tech.userId, pm.userId];
  // always draw the random location so the PRNG sequence (and everything seeded after) stays stable
  const incLocation = (x: { loc?: string }) => {
    const random = pick(["Lobby", "Parkade P1", "Level 3 corridor", "Bike room", "Courtyard"]);
    return x.loc ?? random;
  };
  for (const x of INC) {
    incNo++;
    const b = blds.find((bb) => bb.propertyId === P(x.prop).id)!;
    const at = new Date(now.getTime() - x.days * D);
    const [inc] = await tx.insert(s.incidents).values({
      orgId, number: incNo, propertyId: b.propertyId, buildingId: b.id, type: x.type, severity: x.sev, title: x.title, description: `${x.title}. Logged by front desk.`,
      location: incLocation(x), occurredAt: at, status: x.status, reportedByUserId: pick(staffUsers),
      resolution: x.res ?? null, resolvedAt: x.res ? new Date(at.getTime() + between(4, 72) * H) : null, createdAt: at,
    }).returning();
    await tx.insert(s.timelineEvents).values({ orgId, entityType: "incident", entityId: inc.id, kind: "created", toStatus: "open", visibility: "public", body: `Incident #${incNo} reported.`, createdAt: at });
    if (x.status !== "open") await tx.insert(s.timelineEvents).values({ orgId, entityType: "incident", entityId: inc.id, kind: "comment", visibility: "internal", actorUserId: pm.userId, body: "Reviewed camera footage and spoke with staff on shift.", createdAt: new Date(at.getTime() + 3 * H) });
  }
  await tx.insert(s.orgCounters).values({ orgId, key: "incident", value: incNo });

  /* ── complaints ── */
  const CMP = [
    ["noise", "Loud music from unit above after 11pm"], ["noise", "Construction noise on weekend"], ["parking", "Car parked in my assigned stall"], ["parking", "Visitor parking always full"],
    ["pets", "Dog barking for hours while owner is out"], ["pets", "Pet waste not picked up in courtyard"], ["smoking", "Cigarette smoke coming through vents"], ["smoking", "Smoking on balcony below"],
    ["cleanliness", "Garbage room overflowing"], ["amenity", "Gym equipment broken for two weeks"], ["neighbour", "Neighbour leaving items in hallway"], ["maintenance", "Repair took too long"],
  ] as const;
  let cmpNo = 0;
  for (let i = 0; i < 22; i++) {
    const [cat, subject] = pick(CMP);
    const u = pick(residentUnits);
    const r = occ.find((o) => o.unitId === u.id)!;
    const ageDays = rand() * 60;
    const status = ageDays > 25 ? pick(["resolved", "closed", "dismissed"]) : pick(["new", "acknowledged", "investigating", "resolved"]);
    cmpNo++;
    const at = new Date(now.getTime() - ageDays * D);
    const [c] = await tx.insert(s.complaints).values({
      orgId, number: cmpNo, propertyId: u.propertyId, buildingId: u.buildingId, unitId: u.id, category: cat, subject, description: `${subject}. This has happened several times now.`,
      status, priority: cat === "smoking" || cat === "noise" ? "normal" : "low", residentId: r.residentId, submittedByUserId: r.userId,
      assignedMembershipId: status === "new" ? null : u.propertyId === P("HBC").id || u.propertyId === P("FRT").id ? pm.id : admin.id,
      resolution: ["resolved", "closed", "dismissed"].includes(status) ? "Spoke with the parties involved and sent a bylaw reminder." : null,
      resolvedAt: ["resolved", "closed", "dismissed"].includes(status) ? new Date(at.getTime() + 3 * D) : null, createdAt: at,
    }).returning();
    await tx.insert(s.timelineEvents).values({ orgId, entityType: "complaint", entityId: c.id, kind: "created", toStatus: "new", visibility: "public", body: `Complaint #${cmpNo} received.`, createdAt: at });
  }
  // two recent fitness-centre complaints at Fraser Towers (the assistant demo asks "who has complained about the gym this week?")
  const frtUnits = residentUnits.filter((u) => u.propertyId === P("FRT").id);
  for (const [subject, days, status] of [["Treadmill in the fitness centre broken again", 1.5, "new"], ["Fitness centre too crowded before 8am", 3.2, "acknowledged"]] as const) {
    const u = frtUnits[cmpNo % frtUnits.length];
    const r = occ.find((o) => o.unitId === u.id)!;
    cmpNo++;
    const at = new Date(now.getTime() - days * D);
    const [c] = await tx.insert(s.complaints).values({
      orgId, number: cmpNo, propertyId: u.propertyId, buildingId: u.buildingId, unitId: u.id, category: "amenity", subject, description: `${subject}. Can someone look at the gym?`,
      status, priority: "low", residentId: r.residentId, submittedByUserId: r.userId, assignedMembershipId: status === "new" ? null : pm.id, createdAt: at,
    }).returning();
    await tx.insert(s.timelineEvents).values({ orgId, entityType: "complaint", entityId: c.id, kind: "created", toStatus: "new", visibility: "public", body: `Complaint #${cmpNo} received.`, createdAt: at });
  }
  // Emma's own complaint so the resident view has history
  cmpNo++;
  const [emmaCmp] = await tx.insert(s.complaints).values({
    orgId, number: cmpNo, propertyId: P("FRT").id, buildingId: towerB.id, unitId: emmaUnit.unitId, category: "noise", subject: "Late-night noise from 1304",
    description: "Loud footsteps and music after midnight most weeknights.", status: "acknowledged", residentId: emmaUnit.residentId, submittedByUserId: emma.userId, assignedMembershipId: pm.id,
    createdAt: new Date(now.getTime() - 3 * D),
  }).returning();
  await tx.insert(s.timelineEvents).values([
    { orgId, entityType: "complaint", entityId: emmaCmp.id, kind: "created", toStatus: "new", visibility: "public", body: `Complaint #${cmpNo} received.`, actorUserId: emma.userId, createdAt: new Date(now.getTime() - 3 * D) },
    { orgId, entityType: "complaint", entityId: emmaCmp.id, kind: "comment", visibility: "public", actorUserId: pm.userId, body: "Thanks Emma — we've reached out to the resident in 1304 and will follow up this week.", createdAt: new Date(now.getTime() - 2 * D) },
    { orgId, entityType: "complaint", entityId: emmaCmp.id, kind: "comment", visibility: "internal", actorUserId: pm.userId, body: "Second noise complaint about 1304 this quarter. Bylaw letter if it continues.", createdAt: new Date(now.getTime() - 2 * D) },
  ]);
  await tx.insert(s.orgCounters).values({ orgId, key: "complaint", value: cmpNo });

  /* ── a few notifications so inboxes aren't empty on first login ── */
  const urgent = woRows.find((w) => w.title === "Tower B elevator out of service")!;
  const emmaWo = woRows.find((w) => w.title === "Bathroom fan not working")!;
  await tx.insert(s.notifications).values([
    { orgId, userId: pm.userId, kind: "workorder.created", title: `#${urgent.number} Tower B elevator out of service`, href: `/o/pacific-properties/maintenance/${urgent.id}`, entityType: "work_order", entityId: urgent.id, createdAt: new Date(now.getTime() - 5 * H) },
    { orgId, userId: admin.userId, kind: "workorder.created", title: `#${urgent.number} Tower B elevator out of service`, href: `/o/pacific-properties/maintenance/${urgent.id}`, entityType: "work_order", entityId: urgent.id, createdAt: new Date(now.getTime() - 5 * H) },
    { orgId, userId: emma.userId, kind: "workorder.updated", title: `Your request #${emmaWo.number} was scheduled`, body: "Bathroom fan not working", href: `/o/pacific-properties/maintenance/${emmaWo.id}`, entityType: "work_order", entityId: emmaWo.id, createdAt: new Date(now.getTime() - 40 * H) },
    { orgId, userId: emma.userId, kind: "complaint.updated", title: `Reply on your complaint #${cmpNo}`, href: `/o/pacific-properties/complaints/${emmaCmp.id}`, entityType: "complaint", entityId: emmaCmp.id, createdAt: new Date(now.getTime() - 2 * D) },
  ]);
  const vendorUser = (await tx.select({ userId: s.memberships.userId }).from(s.memberships).where(and(eq(s.memberships.orgId, orgId), inArray(s.memberships.vendorId, [V("Blake").id]))))[0];
  const blakeOpen = woRows.filter((w) => w.vendorId === V("Blake").id && ["assigned", "scheduled", "in_progress"].includes(w.status!)).slice(0, 2);
  if (vendorUser) for (const w of blakeOpen) await tx.insert(s.notifications).values({ orgId, userId: vendorUser.userId, kind: "workorder.assigned", title: `Assigned: #${w.number} ${w.title}`, href: `/o/pacific-properties/maintenance/${w.id}`, entityType: "work_order", entityId: w.id, createdAt: w.firstResponseAt as Date });

  return { workOrders: woRows.length, tasks: taskSeed.length, inspections: inspSeed.length, incidents: incNo, complaints: cmpNo };
}
