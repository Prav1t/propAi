import type { ChatHints, ChatMessage } from "../types";
import type { ToolName } from "../tools/names";
import { parseDateRange, parseDuration, parseTime } from "./dates";
import { extractAmenity, extractCategory, extractLocation, extractUnit, type DemoCall, type DemoPlan } from "./intents";

// Demo-mode phrasings for changes. Each maps to an action tool, which only PREPARES a step: the real rules run,
// and nothing changes until the user approves the plan. Text the demo writes (titles, drafts) comes from the
// user's own words through fixed templates — it never invents facts.

export const TONES = ["professional", "friendly", "concise", "formal", "urgent"] as const;
export type DemoTone = (typeof TONES)[number];

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const tidy = (s: string) => s.replace(/\s+/g, " ").replace(/^[\s:;,.—–-]+|[\s:;,.—–-]+$/g, "").trim();

const VENDOR_WORDS = /\b(inc|ltd|llc|corp|co|services?|elevators?|plumbing|heating|electric(al)?|hvac|mechanical|group|contracting|contractors?|cleaning|pest|locksmiths?|roofing|systems|solutions|safety|landscaping|painting|restoration|glass|appliances?)\b/i;
const NAME = String.raw`([A-Z][\w&'’.-]*(?:\s+(?:[A-Z][\w&'’.-]*|&))*)`;

export function toneOf(text: string): DemoTone | undefined {
  const t = text.toLowerCase();
  if (/\b(friendl\w*|warm\w*|casual\w*|upbeat)\b/.test(t)) return "friendly";
  if (/\b(formal\w*|official)\b/.test(t)) return "formal";
  if (/\b(urgent\w*|emergency|serious)\b/.test(t)) return "urgent";
  if (/\b(concise\w*|short\w*|brief\w*|tighter|fewer words)\b/.test(t)) return "concise";
  if (/\b(professional\w*|neutral)\b/.test(t)) return "professional";
  return undefined;
}

// "tomorrow" → "tomorrow (Tuesday, October 6)" so a notice still reads right on a later day
function anchorDates(s: string, today: string): string {
  return s.replace(/\b(today|tonight|tomorrow)\b/gi, (w) => {
    const r = parseDateRange(w, today);
    if (!r) return w;
    const day = new Date(`${r.from}T12:00:00Z`).toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
    return `${w} (${day})`;
  });
}

// the five house tones; {about} is the user's own sentence
export function draftNotice(about: string, tone: DemoTone, today: string): { title: string; body: string } {
  const fact = anchorDates(tidy(about), today);
  const sentence = cap(fact).replace(/[.!]?$/, ".");
  const title = clip(cap(tidy(about).replace(/^(that|the fact that)\s+/i, "")), 80);
  const body: Record<DemoTone, string> = {
    professional: `Hello residents,\n\n${sentence} We apologize for any inconvenience and thank you for your understanding.\n\nIf you have questions, please contact the management office.\n\nBuilding Management`,
    friendly: `Hi neighbours,\n\nQuick heads-up: ${fact.replace(/[.!]?$/, ".")} Thanks for your patience — the front desk is happy to help if you have any questions.\n\nYour building team`,
    concise: `${sentence} Questions? Contact the management office.`,
    formal: `Dear Residents,\n\nPlease be advised that ${fact.replace(/[.!]?$/, ".")} Management regrets any inconvenience this may cause and thanks you for your cooperation.\n\nSincerely,\nProperty Management`,
    urgent: `IMPORTANT: ${sentence} Please plan accordingly and contact the front desk right away if this affects you.`,
  };
  return { title: tone === "urgent" ? clip(`Important: ${title}`, 80) : title, body: body[tone] };
}

// "saying their fob is ready" → "your fob is ready": a direct message speaks to the resident
const secondPerson = (s: string) => s
  .replace(/\bthey are\b|\bthey're\b/gi, "you're").replace(/\bthey have\b|\bthey've\b/gi, "you have").replace(/\bthey\b/gi, "you")
  .replace(/\btheirs\b/gi, "yours").replace(/\btheir\b/gi, "your").replace(/\bthem\b/gi, "you").replace(/\bthemselves\b/gi, "yourself")
  .replace(/\b(he|she) is\b/gi, "you're").replace(/\b(his|her)\b/gi, "your");

export function draftMessage(about: string, tone: DemoTone, today: string): { subject: string; body: string } {
  about = secondPerson(about);
  const fact = anchorDates(tidy(about), today).replace(/[.!]?$/, ".");
  const body: Record<DemoTone, string> = {
    professional: `Hello,\n\n${cap(fact)} Please let us know if you have any questions.\n\nThank you,\nBuilding Management`,
    friendly: `Hi there,\n\nJust a quick note: ${fact} Let us know if there's anything we can help with!\n\nYour building team`,
    concise: cap(fact),
    formal: `Dear Resident,\n\nWe are writing to inform you that ${fact} Please do not hesitate to contact the management office with any questions.\n\nSincerely,\nProperty Management`,
    urgent: `URGENT: ${cap(fact)} Please contact the front desk as soon as possible.`,
  };
  return { subject: clip(cap(tidy(about)), 80), body: body[tone] };
}

const TONE_TAIL = /[,;.]?\s*(?:(?:and\s+)?(?:keep|make)\s+it|in\s+an?|use\s+an?|tone:?)\s+(?:more\s+|very\s+|a\s+bit\s+)?(?:friendl\w*|formal\w*|urgent\w*|concise\w*|short\w*|brief\w*|professional\w*|casual\w*|warm\w*)(?:\s+tone)?[.!]?\s*$/i;

// what the user wants said: "…saying X", "…that X", "…: X", "…about X"
function messageContent(text: string): string | undefined {
  const m = text.match(/\b(?:saying|to say|that says|letting them know|let them know|telling them|informing them|that)\s+(?:that\s+)?(.+)$/i)
    ?? text.match(/:\s*(.+)$/) ?? text.match(/\babout\s+(.+)$/i);
  // "…, keep it urgent" / "in a friendly tone" is an instruction about the text, not part of it
  const s = m ? tidy(m[1].replace(TONE_TAIL, "").replace(/^["“']|["”']$/g, "")) : "";
  return s.length >= 4 ? s : undefined;
}

function woTitle(text: string): string {
  const stopAhead = String.raw`(?=\s+(?:in|at|on)\s+(?:[A-Z0-9]|the\s+[A-Z])|\s+(?:and|then)\s+(?:assign|dispatch|send|notify|mark)|\s+(?:for\s+)?(?:unit|suite|apt)\b|[.,;!?—–]|\s+-\s+|$)`;
  const m = text.match(new RegExp(String.raw`\b(?:request|order|ticket|wo|job)\s+(?:for|about|regarding|to fix|to repair)\s+(?:the\s+|a\s+|an\s+|my\s+|our\s+)?(.+?)${stopAhead}`, "i"))
    ?? text.match(new RegExp(String.raw`:\s*(?:the\s+|a\s+|an\s+|my\s+|our\s+)?(.+?)${stopAhead}`, "i"));
  let title = m?.[1];
  if (!title) {
    // "My kitchen sink is leaking — please file a request" → the first clause
    const first = text.split(/\s*[—–;!?]\s*|\.\s+|,\s+(?:please|can|could)\b|\s+-\s+|\s+(?:please|can you|could you)\b/i)[0];
    title = first.replace(/^(?:(?:hi|hey|hello|ok|okay)[, ]+)?(?:my|our|the|a|an)\s+/i, "");
  }
  title = tidy(title);
  if (title.length > 40) title = title.split(/\s+(?:and|but|so|which)\s+/i)[0];
  return clip(cap(title), 100) || "Maintenance request";
}

function assignee(text: string): string | undefined {
  const m = text.match(new RegExp(String.raw`\b(?:[Aa]ssign|[Rr]eassign|[Dd]ispatch|[Ss]end)\s+(?:it\s+|this\s+|that\s+)?(?:to\s+)?(?:the\s+)?${NAME}`));
  return m ? tidy(m[1]) : undefined;
}

const woNumberOf = (text: string) => {
  const m = text.match(/\b(?:wo|work\s*order|request|ticket|job)\s*(?:#|no\.?|number)?\s*-?\s*(\d{1,7})\b/i) ?? text.match(/#(\d{1,7})\b/);
  return m ? Number(m[1]) : undefined;
};

function incidentType(t: string): string {
  if (/\b(water|leak\w*|flood\w*|burst)\b/.test(t)) return "water_damage";
  if (/\b(fire|smoke|burning)\b/.test(t)) return "fire";
  if (/\b(injur\w*|fell|fall|hurt|slipped|ambulance)\b/.test(t)) return "injury";
  if (/\b(break-?in|broke in|trespass\w*|tailgat\w*|unauthori[sz]ed|forced entry)\b/.test(t)) return "unauthorized_access";
  if (/\b(vandal\w*|graffiti|damage\w*|smashed|broken window)\b/.test(t)) return "property_damage";
  if (/\b(elevator|generator|boiler|equipment|outage|power)\b/.test(t)) return "equipment_failure";
  if (/\b(noise|dispute|argument|neighbou?r)\b/.test(t)) return "resident";
  if (/\b(security|suspicious|theft|stolen)\b/.test(t)) return "security";
  return "other";
}

function visitorName(text: string): string | undefined {
  const m = text.match(new RegExp(String.raw`\b(?:visitor|guest|contractor|friend|cleaner|technician)\s+(?:named\s+|called\s+)?${NAME}`))
    ?? text.match(new RegExp(String.raw`\b(?:invite|register|expect(?:ing)?|pre-?register)\s+${NAME}`));
  const n = m ? tidy(m[1]).replace(/\s+(?:Tomorrow|Today|Tonight|On|At|For)$/, "") : undefined;
  return n && !/^(A|An|The|My|Our|Unit|Visitor|Guest)$/.test(n) ? n : undefined;
}

// an instruction to the assistant rather than a description of the problem
const COMMAND_START = /^(?:(?:hey|hi|ok|okay)[, ]+)?(?:(?:can|could|would|will) you\s+|please\s+)?(?:create|open|log|file|submit|raise|put in|make)\b/i;

const CARRIERS = /\b(amazon|ups|fedex|purolator|canada post|dhl|intelcom|usps)\b/i;

// returns a plan for a change request, or null when the text isn't one this table understands
export function planAction(text: string, has: (n: ToolName) => boolean, h: ChatHints): DemoPlan | null {
  const t = text.toLowerCase();
  const location = extractLocation(text);
  const unit = extractUnit(text);
  const loc = location && !h.resident ? { location } : {};
  const range = parseDateRange(text, h.today);
  const time = parseTime(text);
  const tools = (calls: DemoCall[], note?: string): DemoPlan => ({ kind: "tools", calls: calls.filter((c) => has(c.name)), note });
  const cannot = (what: string): DemoPlan => ({ kind: "reply", text: `I can't ${what} with your access.` });

  // 1. packages: "a package arrived for unit 602", "log a package for 1204 in Tower A"
  if (/\b(packages?|parcels?|deliver(y|ies))\b/.test(t) && /\b(arrived|came|log|logged|received|record|register|notify|here for|dropped off)\b/.test(t) && unit && !h.resident) {
    if (!has("log_package")) return cannot("log packages");
    const carrier = text.match(CARRIERS)?.[1];
    return tools([{ name: "log_package", input: { unit, ...loc, ...(carrier ? { carrier: carrier.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Ups$|^Dhl$|^Usps$/, (c) => c.toUpperCase()) } : {}) } }]);
  }

  // 2. cancel a booking (before work-order numbers: "booking #42")
  if (/\bcancel\b/.test(t) && (/\b(booking|reservation)\b/.test(t) || extractAmenity(text))) {
    if (!has("cancel_booking")) return cannot("cancel bookings");
    const booking = text.match(/\b(?:booking|reservation)\s*#?\s*(\d{1,7})\b/i)?.[1];
    const amenity = extractAmenity(text);
    const reason = text.match(/\b(?:because|reason[:]?)\s+(.+)$/i)?.[1];
    return tools([{ name: "cancel_booking", input: { ...(booking ? { booking: Number(booking) } : {}), ...(amenity ? { amenity } : {}), ...(range ? { date: range.from } : {}), ...(reason ? { reason: tidy(reason) } : {}) } }]);
  }

  // 3. work-order changes by number
  const number = woNumberOf(text);
  if (number && /\b(assign|reassign|dispatch)\b/.test(t)) {
    if (!has("assign_work_order")) return cannot("assign work");
    const who = assignee(text.replace(/\b(?:wo|work\s*order|request|ticket|job)\s*(?:#|no\.?|number)?\s*-?\s*\d+\s*/i, ""));
    if (!who) return { kind: "reply", text: `Who should WO-${number} go to — a vendor or a staff member?` };
    return tools([{ name: "assign_work_order", input: { number, ...(VENDOR_WORDS.test(who) ? { vendor: who } : { staff: who }) } }]);
  }
  if (number && /\b(mark|set|move|change|close|complete|cancel|reopen|start|put)\b/.test(t) && has("update_work_order_status")) {
    const status = /\bcancel/.test(t) ? "cancelled" : /\b(complete[d]?|done|finished|fixed)\b/.test(t) ? "completed" : /\bclose[d]?\b/.test(t) ? "closed"
      : /\bin progress|started|start\b/.test(t) ? "in_progress" : /\bscheduled\b/.test(t) ? "scheduled" : /\backnowledg/.test(t) ? "acknowledged"
        : /\bawaiting vendor|waiting (on|for) (the )?vendor/.test(t) ? "awaiting_vendor" : /\bawaiting resident|waiting (on|for) (the )?resident/.test(t) ? "awaiting_resident" : null;
    if (!status) return { kind: "reply", text: `What status should WO-${number} move to?` };
    const notes = text.match(/\b(?:with\s+)?(?:(?:resolution\s+)?notes?|resolution)\s*[:—-]\s*(.{4,})$/i)?.[1] ?? text.match(/\b(?:because|with the note|saying)\s+(.{4,})$/i)?.[1];
    return tools([{ name: "update_work_order_status", input: { number, status, ...(notes ? (status === "completed" ? { resolutionNotes: tidy(notes) } : { note: tidy(notes) }) : {}) } }]);
  }
  if (number && /\b(note|comment|update)\b/.test(t) && has("comment_on_work_order")) {
    const body = text.match(/:\s*(.+)$/)?.[1] ?? text.match(/\b(?:saying|that)\s+(.+)$/i)?.[1];
    if (!body) return { kind: "reply", text: `What should the note on WO-${number} say?` };
    const visibility = h.resident ? undefined : /\b(resident|requester|tenant|public)\b/.test(t) ? "public" : /\bvendor\b/.test(t) ? "vendor" : "internal";
    return tools([{ name: "comment_on_work_order", input: { number, body: tidy(body), ...(visibility ? { visibility } : {}) } }]);
  }

  // 4. book an amenity
  if (/\b(book|reserve)\b/.test(t)) {
    const amenity = extractAmenity(text);
    if (!amenity) return { kind: "reply", text: "Which amenity would you like to book, and when?" };
    const date = range?.from ?? h.today;
    if (!time) {
      if (!has("check_amenity_availability")) return cannot("check amenities");
      return tools([{ name: "check_amenity_availability", input: { amenity, date, ...loc } }], "Tell me a start time (and how long) and I'll prepare the booking for you to approve.");
    }
    if (!has("create_booking")) return cannot("book amenities");
    const guests = text.match(/\b(?:for\s+)?(\d{1,4})\s+(?:guests|people|persons)\b/i)?.[1];
    return tools([{ name: "create_booking", input: {
      amenity, date, start: time, ...(parseDuration(text) ? { durationMinutes: parseDuration(text) } : {}), ...(guests ? { guests: Number(guests) } : {}),
      ...(unit && !h.resident ? { unit } : {}), ...loc,
    } }]);
  }

  // 5. visitors
  if ((/\b(register|invite|expect\w*|pre-?register)\b/.test(t) && /\b(visitor|guest|contractor|friend)s?\b/.test(t)) || /\b(guest|visitor)\b.*\b(coming|arriving|visiting)\b/.test(t)) {
    if (!has("register_visitor")) return cannot("register visitors");
    const name = visitorName(text);
    if (!name) return { kind: "reply", text: "What's the visitor's name, and when are they coming?" };
    if (!time) return { kind: "reply", text: `What time is ${name} arriving?` };
    const from = text.match(new RegExp(String.raw`\bfrom\s+(?:the\s+)?${NAME}`));
    const company = from && VENDOR_WORDS.test(from[1]) ? tidy(from[1]) : undefined;
    // "from Summit Elevator Services" is who they are, not where they're going
    const where = extractLocation(company ? text.replace(from![0], "") : text);
    return tools([{ name: "register_visitor", input: {
      name, date: range?.from ?? h.today, from: time, ...(unit ? { unit } : {}), ...(where && !h.resident ? { location: where } : {}), ...(company ? { company, kind: "contractor" } : {}),
    } }]);
  }

  // 6. inspections
  if (/\binspections?\b/.test(t) && /\b(schedule|create|book|set up|plan|add)\b/.test(t)) {
    if (!has("schedule_inspection")) return cannot("schedule inspections");
    if (!location) return { kind: "reply", text: "Which building should the inspection be in?" };
    const template = text.match(/\b(?:using|with|from)\s+(?:the\s+)?(.+?)\s+(?:checklist|template)\b/i)?.[1] ?? text.match(/\b(?:an?|the)\s+([a-z][a-z &/-]+?)\s+inspection\b/i)?.[1];
    return tools([{ name: "schedule_inspection", input: { location, date: range?.from ?? h.today, ...(template ? { template: tidy(template) } : {}), ...(unit ? { unit } : {}) } }]);
  }

  // 7. tasks
  if (/\b(task|to-?do|reminder)\b/.test(t) && /\b(create|add|make|set up|new)\b/.test(t)) {
    if (!has("create_task")) return cannot("create tasks");
    const what = text.match(/\b(?:task|to-?do|reminder)\s*(?:to|for|:|-|—)\s*(.+?)(?=\s+(?:at|in|for)\s+[A-Z]|\s+(?:by|due|before|on)\s+|\s+(?:and\s+)?assign|[.!?]|$)/i)?.[1];
    if (!what) return { kind: "reply", text: "What should the task be?" };
    const who = text.match(new RegExp(String.raw`\b[Aa]ssign(?:ed)?\s+(?:it\s+)?to\s+${NAME}`))?.[1];
    const priority = /\burgent\b/.test(t) ? "urgent" : /\b(high priority|important|asap)\b/.test(t) ? "high" : undefined;
    return tools([{ name: "create_task", input: {
      title: clip(cap(tidy(what)), 200), ...loc, ...(range ? { due: range.from } : {}), ...(time && range ? { dueTime: time } : {}), ...(who ? { assignee: tidy(who) } : {}), ...(priority ? { priority } : {}),
    } }]);
  }

  // 8. incidents
  if (/\bincident\b/.test(t) && /\b(report|log|file|create|record|open)\b/.test(t)) {
    if (!has("create_incident")) return cannot("report incidents");
    const what = text.match(/\bincident\s*(?::|-|—|about|regarding|for)\s*(.+)$/i)?.[1] ?? text.replace(/^.*?\bincident\b\s*/i, "");
    if (tidy(what).length < 4) return { kind: "reply", text: "What happened, and where?" };
    const where = text.match(/\b(?:in|at|on)\s+(?:the\s+)?((?:P\d|lobby|garage|parkade|loading dock|stairwell|hallway|elevator|gym|pool|roof|level\s*\d+|floor\s*\d+)[\w\s-]{0,30}?)(?=[.,;!?]|\s+(?:in|at)\s+[A-Z]|$)/i)?.[1];
    const severity = /\b(critical|life[- ]threatening)\b/.test(t) ? "critical" : /\b(serious|major|severe|injur\w*|fire)\b/.test(t) ? "high" : /\bminor\b/.test(t) ? "low" : undefined;
    return tools([{ name: "create_incident", input: {
      title: clip(cap(tidy(what.split(/[.!?]/)[0])), 160), type: incidentType(t), description: tidy(what), ...loc, ...(unit ? { unit } : {}),
      ...(where ? { where: tidy(where) } : {}), ...(severity ? { severity } : {}),
    } }]);
  }

  // 9. new work orders (incl. residents describing a problem and asking for a request)
  const asksForWo = /\b(create|open|log|file|submit|raise|put in|make|report)\b/.test(t) && /\b(work ?orders?|maintenance|requests?|repairs?|tickets?|wo)\b/.test(t);
  const reportsProblem = /\b(broken|leak\w*|not working|doesn'?t work|isn'?t working|stopped working|down|stuck|clogged|blocked|no (hot )?water|no heat|no power|flood\w*|out of order)\b/.test(t)
    && /\b(please|can you|could you|fix|send someone|report|file|log|create|help)\b/.test(t);
  if (asksForWo || reportsProblem) {
    if (!has("create_work_order")) return cannot("create work orders");
    const category = extractCategory(text);
    const who = h.resident ? undefined : assignee(text);
    const priority = !h.resident && /\burgent\b/.test(t) ? "urgent" : undefined;
    const create: DemoCall = { name: "create_work_order", input: {
      title: woTitle(text), ...(COMMAND_START.test(text) ? {} : { description: text.trim() }), ...(category ? { category } : {}), ...loc, ...(unit ? { unit } : {}),
      ...(/\bemergency\b/.test(t) ? { emergency: true } : {}), ...(priority ? { priority } : {}),
      ...(who ? (VENDOR_WORDS.test(who) ? { assignVendor: who } : { assignStaff: who }) : {}),
    } };
    // look for a similar open request first, so a duplicate is visible before anyone approves
    const dupCheck: DemoCall[] = !h.resident && category && has("search_work_orders") ? [{ name: "search_work_orders", input: { view: "open", category, ...loc, limit: 3 } }] : [];
    // "…and notify the residents": a notice goes in the same plan, after the work order (steps stop at the first failure)
    const notify: DemoCall[] = !h.resident && has("send_announcement") && /\b(notify|tell|inform|let|warn)\b[^.]*\b(residents|everyone|tenants|occupants|building)\b/.test(t)
      ? (() => {
          const about = `${String(create.input.title)}${location ? ` at ${location}` : ""} — a repair request has been filed and we will post updates here`;
          const tone = toneOf(text) ?? "professional";
          const d = draftNotice(about, tone, h.today);
          return [{ name: "send_announcement" as const, input: { title: d.title, body: d.body, audience: "residents", ...loc, category: "maintenance", tone, about } }];
        })()
      : [];
    return tools([...dupCheck, create, ...notify]);
  }
  // 10. direct message to one resident
  const toResident = text.match(new RegExp(String.raw`\b(?:[Mm]essage|[Tt]ext|[Ee]mail|[Ww]rite to|[Tt]ell|[Cc]ontact)\s+(?:[Tt]he\s+)?(?:(?:[Rr]esident|[Tt]enant|[Oo]wner)s?\s+(?:of|in|at)\s+(?:[Uu]nit\s+)?\S+|[Uu]nit\s+\S+|${NAME})`));
  if (!h.resident && toResident && !/\b(everyone|all|whole building)\b/.test(t) && !/\bresidents\b(?!\s+(?:of|in|at)\s+(?:unit\s+)?#?\d)/.test(t)) {
    if (!has("message_resident")) return cannot("message residents");
    const about = messageContent(text);
    if (!about) return { kind: "reply", text: "What should the message say?" };
    const name = !unit ? toResident[1] : undefined;
    const tone = toneOf(text) ?? "professional";
    const d = draftMessage(about, tone, h.today);
    return tools([{ name: "message_resident", input: { ...(unit ? { unit } : {}), ...(name ? { resident: tidy(name) } : {}), ...loc, subject: d.subject, body: d.body, tone, about } }]);
  }

  // 11. announcements / notices to residents
  if (/\b(send|notify|announce|post|tell|let|inform|message|email|text|publish)\b/.test(t) && /\b(residents?|everyone|tenants?|owners?|occupants?|building|tower|announcement|notice|staff)\b/.test(t)) {
    if (!has("send_announcement")) return cannot("send announcements");
    const about = messageContent(text);
    if (!about) return { kind: "reply", text: "What should the announcement say?" };
    const tone = toneOf(text.replace(about, "")) ?? "professional";
    const d = draftNotice(about, tone, h.today);
    const audience = /\bstaff\b/.test(t) && !/\b(residents?|tenants?|owners?)\b/.test(t) ? "staff" : /\bstaff\b/.test(t) ? "everyone" : "residents";
    const category = /\b(closed|closure|shut ?down|unavailable|out of service|maintenance|repair|water|power|elevator)\b/.test(about.toLowerCase()) ? "maintenance" : /\b(party|event|bbq|celebrat)\w*/.test(about.toLowerCase()) ? "event" : "general";
    return tools([{ name: "send_announcement", input: { title: d.title, body: d.body, audience, ...loc, category, tone, about } }]);
  }

  return null;
}

// "make it more formal", "friendlier please", "shorter" → redraft the last announcement or message in that tone
export function planRedraft(text: string, history: ChatMessage[], h: ChatHints, has: (n: ToolName) => boolean): DemoPlan | null {
  const t = text.toLowerCase();
  if (!/\b(make it|rewrite|redraft|reword|more|less|tone|sound|version)\b/.test(t) && !/^(friendlier|shorter|more \w+)/.test(t)) return null;
  const tone = toneOf(text);
  if (!tone) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "assistant" || !m.toolCalls) continue;
    const prev = [...m.toolCalls].reverse().find((c) => c.name === "send_announcement" || c.name === "message_resident");
    if (!prev) continue;
    const about = typeof prev.input.about === "string" ? prev.input.about : undefined;
    if (!about || !has(prev.name as ToolName)) return null;
    if (prev.name === "send_announcement") {
      const d = draftNotice(about, tone, h.today);
      return { kind: "tools", calls: [{ name: "send_announcement", input: { ...prev.input, title: d.title, body: d.body, tone } }] };
    }
    const d = draftMessage(about, tone, h.today);
    return { kind: "tools", calls: [{ name: "message_resident", input: { ...prev.input, subject: d.subject, body: d.body, tone } }] };
  }
  return null;
}

export const APPROVE_HINT = "I can't approve changes myself — use **Approve** on the plan above (or **Edit** to adjust it first). Nothing has changed until you do.";
export const isConfirmation = (text: string) =>
  /^(?:(?:yes|yep|yeah|ok(?:ay)?|sure|go ahead|do it|please do|approve[d]?|confirm(?:ed)?|send it|book it|sounds good|looks good|proceed|that'?s (?:fine|right|correct))\b[\s,!.]*)+(?:please|thanks?)?[\s!.]*$/i.test(text.trim());
