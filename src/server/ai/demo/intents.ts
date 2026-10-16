import type { ChatHints, ChatMessage } from "../types";
import { ACTION_TOOL_NAMES, type ToolName } from "../tools/names";
import { APPROVE_HINT, isConfirmation, planAction, planRedraft } from "./actions";
import { addDaysIso, parseDateRange, parseDuration, parseTime } from "./dates";

// The demo model: a deterministic, rule-based planner that maps common phrasings to the same typed tools a
// language model would call. It never invents data — every answer is composed from tool results.

export type DemoCall = { name: ToolName; input: Record<string, unknown> };
export type DemoPlan =
  | { kind: "tools"; calls: DemoCall[]; note?: string }
  | { kind: "reply"; text: string };

const AMENITY_WORDS = [
  "party room", "fitness centre", "fitness center", "meeting room", "guest suite", "media room", "games room", "tennis court",
  "yoga studio", "roof deck", "hot tub", "bike room", "rooftop", "lounge", "theatre", "theater", "gym", "pool", "sauna", "court",
  "bbq", "barbecue", "workspace", "co-working", "coworking",
];

const CATEGORY_WORDS: [string, RegExp][] = [
  ["elevator", /\b(elevators?|lifts?)\b/],
  ["hvac", /\b(hvac|heat(ing)?|furnace|air[- ]?condition\w*|a\/c|cooling|thermostat|ventilation|rtu)\b/],
  ["plumbing", /\b(leak\w*|sinks?|toilets?|pipes?|drains?|faucets?|plumbing|flood\w*|water)\b/],
  ["electrical", /\b(electric\w*|power|outlets?|breakers?|lighting|lights?)\b/],
  ["appliance", /\b(fridge|refrigerator|stove|oven|dishwasher|washer|dryer|appliances?)\b/],
  ["doors_locks", /\b(doors?|locks?|keys?|fobs?)\b/],
  ["pest", /\b(pests?|mice|mouse|rats?|cockroach\w*|bugs?|bedbugs?)\b/],
  ["fire_safety", /\b(fire|alarms?|sprinklers?|smoke detectors?)\b/],
  ["parking", /\b(parking|garage gate|parkade)\b/],
];

const LOCATION_STOP = /^(unit|suite|apt|apartment|room|sunday|monday|tuesday|wednesday|thursday|friday|saturday|january|february|march|april|may|june|july|august|september|october|november|december|am|pm|today|tomorrow|my|our|this|next|last|all|every|each|i|demo|wo)\b/i;

export function extractLocation(text: string): string | undefined {
  const re = /\b(?:at|in|for|on|from|across|of)\s+(?:the\s+)?([A-Z][A-Za-z'’.-]*(?![0-9])(?:\s+(?:[A-Z][A-Za-z'’.-]*|[A-Z0-9]{1,3}\b))*)/g;
  for (const m of text.matchAll(re)) {
    const phrase = m[1].replace(/[.’',-]+$/, "").trim();
    if (!phrase || LOCATION_STOP.test(phrase)) continue;
    if (AMENITY_WORDS.includes(phrase.toLowerCase())) continue;
    return phrase;
  }
  return undefined;
}

export function extractUnit(text: string): string | undefined {
  const m = text.match(/\b(?:unit|suite|apt\.?|apartment)\s*#?\s*([A-Za-z]?\d{1,5}[A-Za-z]?)\b/i) ?? text.match(/(?:^|\s)#(\d{2,5})\b/);
  return m?.[1];
}

export function extractAmenity(text: string): string | undefined {
  const t = text.toLowerCase();
  return AMENITY_WORDS.find((w) => new RegExp(`\\b${w.replace(/[-]/g, "[- ]?")}\\b`).test(t));
}

export function extractCategory(text: string): string | undefined {
  const t = text.toLowerCase();
  return CATEGORY_WORDS.find(([, re]) => re.test(t))?.[0];
}

export function extractTopic(text: string): string | undefined {
  const m = text.match(/\b(?:about|regarding|re:?|over)\s+(?:the\s+|a\s+|an\s+|my\s+)?([a-z][a-z\s'-]{1,30}?)(?=\s+(?:this|last|today|yesterday|in|at|on|for|from|since|during)\b|[?.!,]|$)/i);
  const topic = m?.[1].trim().toLowerCase();
  return topic && !/^(it|that|this|them|things?)$/.test(topic) ? topic : undefined;
}

const MUTATION = /(?:^|[.!?]\s+)(?:(?:hey|hi|ok|okay)[, ]+)?(?:(?:can|could|would|will) you\s+|please\s+|i(?:'d| would) like to\s+|i (?:want|need) to\s+|go ahead and\s+|let'?s\s+)?(create|open a|log|file|submit|raise|book|reserve|cancel|send|notify|message|email|text|tell(?!\s+me\b)|announce|post|assign|reassign|dispatch|schedule|reschedule|add|register|invite|delete|remove|update|change|close|resolve|mark|approve|reject|deny|check (?:in|out))\b/i;

// questions answered from documents and the knowledge base rather than records
const KNOWLEDGE = /\b(rules?|polic(y|ies)|bylaws?|procedures?|guidelines?|allowed|permitted|prohibited|can i|may i|am i allowed|are we allowed|what (do|should) (i|we) do|how do (i|we)|what happens if|deposits?|quiet hours|pets?|dogs?|cats?|smok\w*|barbecues?|bbqs?|move[- ]?(in|out)|moving|garbage|recycl\w*|organics|insurance|muster|evacuat\w*|fire (safety|plan|drill|alarm)|shut[- ]?off|after[- ]hours|agm|minutes|resolutions?|privacy|personal information|tenancy|lease)\b/;

// questions are answered by looking things up; requests to change something are prepared as plans
const QUESTION = /^(?:(?:hey|hi|ok|okay)[, ]+)?(who|what|which|when|where|why|how|is|are|was|were|do|does|did|has|have|any|show|list|find|search|look up|summari[sz]e|give me|tell me|get me|count)\b/i;

const link = (h: ChatHints, path: string, label: string) => `[${label}](/o/${h.orgSlug}${path})`;

// changes there's no assistant action for (yet): say so and link the page where it's done
function notFromChat(h: ChatHints, what: string, path?: string, label?: string) {
  return `I can't ${what} from chat.` + (path ? ` You can do it here: ${link(h, path, label ?? "open the page")}.` : "");
}

function refusal(what: string) {
  return `I can't look up ${what} with your access. I only work with information your role is allowed to see, so I haven't searched for it.`;
}

export function capabilities(h: ChatHints, available: ReadonlySet<string>): string {
  const ex = h.resident
    ? ["Do I have any packages?", "What's the status of my maintenance requests?", "Book the party room tomorrow at 7 PM", "My kitchen sink is leaking — please file a request", "Invite my guest Sam Lee tomorrow at 6 PM"]
    : [
        available.has("search_work_orders") && "Show me all overdue maintenance requests",
        available.has("vendor_performance") && "Which vendor has been the slowest this month?",
        available.has("search_incidents") && "Summarize today's incidents",
        available.has("create_work_order") && available.has("assign_work_order") && "Create a work order for the broken elevator in Tower B and assign Summit Elevator",
        available.has("send_announcement") && "Send residents of Fraser Towers a notice saying the pool will be closed tomorrow",
        available.has("log_package") && "A package arrived for unit 1204 in Tower A",
        (available.has("daily_brief") || available.has("ops_kpis")) && "Give me my morning briefing",
        available.has("compare_periods") && "How much did maintenance spending change this quarter?",
        available.has("property_health") && "Which property needs the most attention?",
      ].filter((x): x is string => !!x);
  const acts = [...available].some((n) => (ACTION_TOOL_NAMES as readonly string[]).includes(n));
  return `I can look up live records you have access to${acts ? " and prepare changes for you to approve — nothing changes until you click Approve" : ""}. Try:\n${ex.map((e) => `- ${e}`).join("\n")}`;
}

// the whole intent table, most specific first
export function planDemo(raw: string, available: ReadonlySet<string>, h: ChatHints, history?: ChatMessage[]): DemoPlan {
  const text = raw.trim();
  const t = text.toLowerCase();
  const has = (n: ToolName) => available.has(n);
  const tools = (calls: DemoCall[], note?: string): DemoPlan => {
    const ok = calls.filter((c) => has(c.name));
    return ok.length ? { kind: "tools", calls: ok, note } : { kind: "reply", text: refusal("that") };
  };
  const location = extractLocation(text);
  const unit = extractUnit(text);
  const range = parseDateRange(text, h.today);
  const loc = location ? { location } : {};

  if (!t) return { kind: "reply", text: capabilities(h, available) };
  if (/\b(help|what can you (do|help with)|how (do|can) i use you|what do you know)\b/.test(t)) return { kind: "reply", text: capabilities(h, available) };

  // "yes, go ahead" — approval is a button press by the user, never something the assistant does
  if (isConfirmation(text)) return { kind: "reply", text: APPROVE_HINT };
  if (history) {
    const again = planRedraft(text, history, h, has);
    if (again) return again;
  }

  // requests to change something → action tools, which only prepare a plan
  if (!QUESTION.test(text)) {
    const act = planAction(text, has, h);
    if (act) return act.kind === "tools" && !act.calls.length ? { kind: "reply", text: refusal("that") } : act;
  }
  const mut = text.match(MUTATION);
  if (mut) {
    const verb = mut[1].toLowerCase();
    if (/^(approve|reject|deny)$/.test(verb)) return { kind: "reply", text: notFromChat(h, "approve or reject requests", h.resident ? "/amenities/bookings" : "/amenities/bookings?view=pending", h.resident ? "Your bookings" : "Bookings waiting for approval") };
    if (/^check (in|out)$/.test(verb)) return { kind: "reply", text: notFromChat(h, "check visitors in or out", "/visitors", "Visitors") };
    if (/^(delete|remove)$/.test(verb)) return { kind: "reply", text: "I don't delete records. Open the record to archive or cancel it, or ask me to cancel a specific request or booking." };
    return { kind: "reply", text: `I didn't catch which change you want. ${capabilities(h, available)}` };
  }

  // rules, policies and procedures are answered from the organization's documents, with citations
  if (has("search_documents") && /\b(list|show|find)\b.*\bdocuments?\b/.test(t)) {
    const category = (["bylaws", "rules", "policy", "minutes", "notice", "insurance", "manual", "lease", "form", "financial"] as const).find((c) => new RegExp(`\\b${c}`).test(t));
    return tools([{ name: "search_documents", input: { ...(category ? { category } : {}), ...loc } }]);
  }
  // (questions about people — numbers, emails, who lives where — go to the directory rules further down, not documents)
  if (KNOWLEDGE.test(t) && !/\b(emergency (number|contact|phone)|office hours|phone|email|who lives|contact details)\b/.test(t) && !/\b(average|avg|resolution time|response time|how many|trend\w*|rate)\b/.test(t)) {
    if (!has("search_knowledge")) return { kind: "reply", text: refusal("your organization's documents") };
    return tools([{ name: "search_knowledge", input: { question: text, ...(location && !h.resident ? { location } : {}) } }]);
  }

  const woNumber = text.match(/\b(?:wo|work\s*order|request|ticket|job)\s*(?:#|no\.?|number)?\s*-?\s*(\d{1,7})\b/i);
  if (woNumber) return tools([{ name: "get_work_order", input: { number: Number(woNumber[1]) } }]);

  // numbers about the operation come from the metric catalog (analytics tools), never from listing records
  const analytics = !h.resident ? planAnalytics(text, t, has, range, loc) : null;
  if (analytics) return analytics;

  if (/\b(briefing|brief me|daily brief|morning report|what do i need to know today|what('s| is) (urgent|on my plate) today)\b/.test(t) && has("daily_brief")) {
    return tools([{ name: "daily_brief", input: {} }]);
  }
  if (/\b(briefing|brief me|kpis?|metrics|dashboard|how are (we|things) (doing|going)|overview|status report|morning report|operations summary|ops summary|stats|statistics)\b/.test(t)) {
    if (h.resident) return { kind: "reply", text: capabilities(h, available) };
    return tools([
      { name: "ops_kpis", input: {} },
      { name: "search_work_orders", input: { view: "overdue", limit: 5, ...loc } },
      { name: "search_incidents", input: { since: h.today, ...loc } },
    ].filter((c) => has(c.name as ToolName)) as DemoCall[]);
  }

  const isVendor = /\b(vendors?|contractors?|suppliers?|plumbers?|electricians?)\b/.test(t);
  if (isVendor && /\b(slow\w*|fast\w*|quick\w*|perform\w*|sla|response|best|worst|reliab\w*|scorecards?|miss\w*|on[- ]time|late)\b/.test(t)) {
    if (!has("vendor_performance")) return { kind: "reply", text: refusal("vendor performance") };
    const from = range ? (range.from === range.to ? addDaysIso(range.from, -30) : range.from) : addDaysIso(h.today, -30);
    return tools([{ name: "vendor_performance", input: { from, to: range && range.from !== range.to ? range.to : h.today, ...(extractCategory(text) ? { category: extractCategory(text) } : {}), ...loc } }]);
  }
  if (isVendor) {
    if (!has("search_vendors")) return { kind: "reply", text: refusal("vendors") };
    const category = extractCategory(text);
    return tools([{ name: "search_vendors", input: { ...(category ? { category: category === "doors_locks" ? "locksmith" : category === "pest" ? "pest_control" : category } : {}), ...loc } }]);
  }

  if (/\b(on.?site|in the building)\b/.test(t) && !/\b(staff|shift|working|on duty)\b/.test(t)) {
    return tools([{ name: "search_visitors", input: { view: "on_site", ...loc } }]);
  }
  if (/\b(preventive|preventative|pm schedules?|pm due|pms)\b/.test(t)) {
    if (!has("calendar_range")) return { kind: "reply", text: refusal("the maintenance calendar") };
    const from = range?.from ?? h.today;
    return tools([{ name: "calendar_range", input: { from, to: range?.to && range.to !== from ? range.to : addDaysIso(from, 6), sources: ["pm"], ...loc } }]);
  }
  if (/\b(packages?|parcels?|deliveries|delivery)\b/.test(t)) {
    const older = t.match(/(?:more than|over|longer than|at least|>)\s*(\d{1,3})\s*days?/);
    return tools([{ name: "search_packages", input: {
      view: /\b(picked up|collected|released)\b/.test(t) ? "picked_up" : "waiting",
      ...(older ? { olderThanDays: Number(older[1]) } : {}), ...(unit && !h.resident ? { unit } : {}), ...loc,
    } }]);
  }

  if (/\b(visitors?|guests?)\b/.test(t) && !/\bguest suite\b/.test(t)) {
    const view = /\b(on.?site|here now|in the building|checked in|currently|right now)\b/.test(t) ? "on_site"
      : /\b(upcoming|coming|next week|tomorrow|later this week|expecting)\b/.test(t) ? "upcoming"
        : /\b(past|yesterday|last week|history|previous)\b/.test(t) ? "past" : "today";
    return tools([{ name: "search_visitors", input: { view, ...loc } }]);
  }

  if (/\b(on shift|on duty|working (now|today|right now|tonight)|who'?s (on|working|in today|in now)|who is (on|working)|on[- ]call|at the desk)\b/.test(t)) {
    if (!has("whos_on_shift")) return { kind: "reply", text: refusal("the staff schedule") };
    return tools([{ name: "whos_on_shift", input: { ...loc } }]);
  }
  if (/\b(hand-?off|hand off|previous shift|last shift|earlier shift|shift summary|summary of (the|my) shift|what happened (during|on|in|over) (the )?(last|previous|earlier|night|day) ?shift)\b/.test(t)) {
    if (!has("shift_summary")) return { kind: "reply", text: refusal("shift handoffs") };
    return tools([{ name: "shift_summary", input: { ...loc } }]);
  }

  if (/\bincidents?\b|\bsecurity (issues?|events?|reports?)\b/.test(t)) {
    if (!has("search_incidents")) return { kind: "reply", text: refusal("incidents") };
    if (range) return tools([{ name: "search_incidents", input: { since: range.from, until: range.to, ...loc } }]);
    return tools([{ name: "search_incidents", input: { view: /\b(open|unresolved|active|ongoing)\b/.test(t) ? "open" : "recent", ...loc } }]);
  }

  if (/\bcomplain\w*\b/.test(t)) {
    if (!has("search_complaints")) return { kind: "reply", text: refusal("complaints") };
    const topic = extractTopic(text);
    const view = /\b(resolved|closed)\b/.test(t) && !/\bunresolved\b/.test(t) ? "resolved" : range || /\b(all|who)\b/.test(t) ? "all" : "open";
    return tools([{ name: "search_complaints", input: { view, ...(topic ? { q: topic } : {}), ...(range ? { since: range.from } : {}), ...loc } }]);
  }

  const amenity = extractAmenity(text);
  if (amenity && /\b(available|availability|free|open|busy|booked up)\b/.test(t)) {
    return tools([{ name: "check_amenity_availability", input: {
      amenity, date: range?.from ?? h.today, ...(parseTime(text) ? { start: parseTime(text) } : {}), ...(parseDuration(text) ? { durationMinutes: parseDuration(text) } : {}), ...loc,
    } }]);
  }
  if (/\b(bookings?|reservations?|reserved)\b/.test(t)) {
    return tools([{ name: "search_bookings", input: {
      view: /\b(pending|approval|to approve|waiting)\b/.test(t) ? "pending" : /\b(past|previous|history)\b/.test(t) ? "past" : "upcoming",
      ...(range && range.from === range.to ? { date: range.from } : {}), ...(amenity ? { amenity } : {}), ...loc,
    } }]);
  }

  if (/\binspections?\b/.test(t)) {
    if (!has("search_inspections")) return { kind: "reply", text: refusal("inspections") };
    return tools([{ name: "search_inspections", input: { view: /\b(overdue|late|missed)\b/.test(t) ? "overdue" : /\b(completed|done|past|failed|results?)\b/.test(t) ? "completed" : "upcoming", ...loc } }]);
  }
  if (/\b(tasks?|to-?dos?)\b/.test(t)) {
    if (!has("search_tasks")) return { kind: "reply", text: refusal("tasks") };
    return tools([{ name: "search_tasks", input: { view: /\b(overdue|late)\b/.test(t) ? "overdue" : /\b(my|mine|me)\b/.test(t) ? "mine" : /\b(done|completed|finished)\b/.test(t) ? "done" : "open", ...loc } }]);
  }

  if (/\b(assets?|equipment|rtu-?\s?\d*|boilers?|chillers?|generators?|elevator cars?|recurring|repeat(ed)? (failures?|problems?|issues?)|keeps? (breaking|failing)|downtime|out of service)\b/.test(t)) {
    if (!has("asset_history")) return { kind: "reply", text: refusal("equipment records") };
    const tag = text.match(/\b(rtu|ahu|mua|ch|blr|gen|el)[- ]?(\d{1,3})\b/i);
    const named = text.match(/\b(?:hvac unit|unit|boiler|chiller|generator|elevator car|car)\s*#?\s*(\d{1,3})\b/i);
    const recurring = /\b(recurring|repeat\w*|keeps? (breaking|failing)|most (failures|problems|issues)|chronic|frequent\w*)\b/.test(t);
    const asset = tag ? `${tag[1].toUpperCase()}-${tag[2]}` : named ? named[0] : /\bgenerator\b/.test(t) ? "generator" : /\bboiler\b/.test(t) ? "boiler" : /\bchiller\b/.test(t) ? "chiller" : undefined;
    if (asset && !recurring) return tools([{ name: "asset_history", input: { asset, ...loc } }]);
    const category = extractCategory(text);
    return tools([{ name: "asset_history", input: { ...(recurring ? { recurring: true } : {}), ...(category ? { category } : {}), ...loc } }]);
  }

  if (/\b(who lives|residents?|tenants?|owners?|occupants?|neighbou?rs?)\b/.test(t) && !/\bmy (unit|home|building)\b/.test(t)) {
    if (!has("search_residents")) return { kind: "reply", text: refusal("other residents' details") + (h.resident ? " I can tell you about your own unit, requests, packages, bookings and guests." : "") };
    const name = text.match(/\b(?:named|called|resident|tenant|owner)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
    return tools([{ name: "search_residents", input: { ...(unit ? { unit } : {}), ...(name ? { q: name[1] } : {}), ...loc } }]);
  }

  if (/\b(my (unit|home|building|address|suite)|emergency (number|contact|phone|info)|office hours|management (office|contact|phone|number)|building (info|contact)|concierge (number|phone))\b/.test(t) && has("my_home")) {
    return tools([{ name: "my_home", input: {} }]);
  }
  const isWo = /\b(work ?orders?|maintenance|requests?|repairs?|tickets?|jobs?|wos?|fix(es)?|emergenc\w*)\b/.test(t) || (!!extractCategory(text) && /\b(open|overdue|broken|issues?|problems?)\b/.test(t));
  if (isWo || /\b(overdue|past due|sla breach\w*|late)\b/.test(t)) {
    if (!has("search_work_orders")) return { kind: "reply", text: refusal("maintenance requests") };
    const view = /\b(overdue|past due|late|breach\w*)\b/.test(t) ? "overdue"
      : /\bemergenc\w*\b/.test(t) ? "emergency"
        : /\bunassigned\b/.test(t) ? "unassigned"
          : /\b(completed|finished|done|closed|resolved)\b/.test(t) ? "completed"
            : /\b(all|history|every)\b/.test(t) && h.resident ? "all"
              : /\b(my|mine|assigned to me)\b/.test(t) && !h.resident ? "mine" : "open";
    const category = extractCategory(text);
    return tools([{ name: "search_work_orders", input: { view, ...(category ? { category } : {}), ...loc } }]);
  }

  if (/\bunits?\b|\b(vacant|vacancies|occupied|empty)\b/.test(t)) {
    if (!has("search_units")) return { kind: "reply", text: refusal("units") };
    return tools([{ name: "search_units", input: { ...(unit ? { q: unit } : {}), ...(/\b(vacant|vacancies|empty)\b/.test(t) ? { status: "vacant" } : {}), ...loc } }]);
  }
  if (/\b(properties|buildings|portfolio|sites)\b/.test(t)) {
    if (!has("search_properties")) return { kind: "reply", text: refusal("properties") };
    return tools([{ name: "search_properties", input: {} }]);
  }
  if (/\b(announcements?|notices?|news|bulletins?)\b/.test(t)) return tools([{ name: "recent_announcements", input: {} }]);
  if (/\b(calendar|schedule|scheduled|agenda|appointments?|what'?s (on|happening|planned|coming up))\b/.test(t)) {
    if (!has("calendar_range")) return { kind: "reply", text: refusal("the calendar") };
    return tools([{ name: "calendar_range", input: { from: range?.from ?? h.today, to: range?.to ?? range?.from ?? h.today, ...loc } }]);
  }

  if (/^(hi|hello|hey|good (morning|afternoon|evening)|thanks|thank you)\b/.test(t) && t.length < 40) {
    return { kind: "reply", text: /^thank/.test(t) ? "You're welcome." : `Hello! ${capabilities(h, available)}` };
  }
  // any other question: look in the organization's documents before admitting the demo can't parse it
  if ((QUESTION.test(text) || /\?\s*$/.test(text)) && has("search_knowledge")) {
    return tools([{ name: "search_knowledge", input: { question: text, ...(location && !h.resident ? { location } : {}) } }]);
  }
  return { kind: "reply", text: `I'm running in demo mode without a language model, so I only understand a fixed set of questions. ${capabilities(h, available)}` };
}

/* ───────────── analytics questions (Iteration 9) ───────────── */

type Range = ReturnType<typeof parseDateRange>;

// which catalog metric a question is about (most specific first)
export function metricFor(t: string): string | undefined {
  if (/\b(spend\w*|costs?|expenses?|money)\b/.test(t)) return "maintenance_spend";
  if (/\b(serious|critical|high[- ]severity)\b.*\bincidents?\b/.test(t)) return "serious_incidents";
  if (/\bincidents?\b/.test(t)) return "incidents_reported";
  if (/\bcomplain\w*\b.*\b(resolve|resolution|fix)\w*\b/.test(t)) return "complaint_resolution_hours";
  if (/\bcomplain\w*\b/.test(t)) return "complaints_created";
  if (/\bdowntime\b/.test(t)) return "downtime_hours";
  if (/\binspections?\b.*\b(fail\w*)\b|\bfail\w* inspections?\b/.test(t)) return "inspection_failure_rate";
  if (/\b(pick ?up time|time to pick ?up|picked up)\b/.test(t)) return "package_pickup_hours";
  if (/\bpackages?\b/.test(t)) return "packages_received";
  if (/\b(bookings?|reservations?)\b/.test(t)) return "amenity_bookings";
  if (/\b(sla|on time|within (target|sla)|met (the|their) target)\b/.test(t)) return "sla_compliance";
  if (/\b(response time|respond\w*|first response)\b/.test(t)) return "first_response_hours";
  if (/\b(resolution time|time to (fix|resolve|complete|close)|resolve\w*|fix\w*)\b/.test(t)) return "resolution_hours";
  if (/\b(backlog|open requests?|still open)\b/.test(t)) return "open_backlog";
  if (/\btasks?\b.*\b(done|completed|finished)\b/.test(t)) return "tasks_completed";
  if (/\b(requests?|work ?orders?|tickets?|repairs?|maintenance)\b/.test(t)) return /\b(completed|closed|finished|resolved)\b/.test(t) ? "requests_completed" : "requests_created";
  return undefined;
}

function presetFor(t: string): string | undefined {
  if (/\bthis quarter\b|\bquarter to date\b/.test(t)) return "qtd";
  if (/\bthis month\b|\bmonth to date\b/.test(t)) return "mtd";
  if (/\bthis year\b|\byear to date\b/.test(t)) return "ytd";
  if (/\b(this|past|last) week\b|\blast 7 days\b/.test(t)) return "7d";
  if (/\b(last|past) (3 months|90 days|quarter)\b/.test(t)) return "90d";
  if (/\b(last|past) (year|12 months)\b/.test(t)) return "365d";
  return undefined;
}

function breakdownFor(t: string, metric: string): string | undefined {
  if (/\b(which|what|each|per|by) (property|properties|building site)\b|\bhighest .* (at|by) property\b|\bproperty has\b/.test(t)) return "property";
  if (/\b(which|each|per|by) buildings?\b|\bbuilding has\b/.test(t)) return "building";
  if (/\b(most common|what kinds?|which kinds?|types? of|by (category|type)|what (are|were) .* about|categor(y|ies))\b/.test(t)) return metric.startsWith("incident") || metric === "serious_incidents" ? "type" : metric === "amenity_bookings" ? "amenity" : metric.startsWith("package") ? "carrier" : "category";
  if (/\b(which|each|per|by) amenit(y|ies)\b/.test(t)) return "amenity";
  return undefined;
}

function planAnalytics(text: string, t: string, has: (n: ToolName) => boolean, range: Range, loc: { location?: string }): DemoPlan | null {
  if (/\b(vendors?|contractors?)\b/.test(t)) return null; // vendor_performance answers these
  if (/\b(health score|how healthy|property health|healthiest|least healthy|needs? (the most )?attention)\b/.test(t)) {
    return has("property_health") ? { kind: "tools", calls: [{ name: "property_health", input: { ...loc } }] } : null;
  }
  const numeric = /\b(how (much|many)|average|avg|mean|rate|percent\w*|%|trend\w*|volume|spend\w*|costs?|expenses?|most common|highest|lowest|most|fewest|top|compar\w*|change[ds]?|increas\w*|decreas\w*|grew|growth|up or down|vs\.?|versus)\b/.test(t);
  if (!numeric) return null;
  if (/\b(waiting|right now|on site|here now|today)\b/.test(t) && /\b(packages?|visitors?|guests?)\b/.test(t)) return null; // live lists
  if (/\boverdue\b/.test(t) && !/\b(rate|percent|trend|average)\b/.test(t)) return null; // listing overdue work answers this
  const metric = metricFor(t);
  if (!metric) return null;
  const change = /\b(compar\w*|change[ds]?|increas\w*|decreas\w*|grew|growth|up or down|vs\.?|versus|than last)\b/.test(t);
  const preset = presetFor(t);
  if (change && has("compare_periods")) {
    const comparison = preset === "qtd" || /\bquarter\b/.test(t) ? "quarter" : preset === "mtd" || /\bmonth\b/.test(t) ? "month" : preset === "7d" || /\bweek\b/.test(t) ? "7d" : "30d";
    return { kind: "tools", calls: [{ name: "compare_periods", input: { metric, comparison, ...loc } }] };
  }
  if (!has("query_metrics")) return null;
  const breakdown = breakdownFor(t, metric);
  const explicit = range && range.from !== range.to && !preset ? { from: range.from, to: range.to } : {};
  return { kind: "tools", calls: [{ name: "query_metrics", input: { metrics: [metric], ...(preset && !explicit.from ? { period: preset } : {}), ...explicit, ...(breakdown ? { breakdown } : {}), ...loc } }] };
}
