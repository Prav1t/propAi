// The AI policy engine: decides whether an assistant action runs on its own, waits for approval, or is not allowed.
// Pure functions here; loading and saving rules lives in policies.ts.

export type RiskClass = 1 | 2 | 3 | 4 | 5;
export type PolicyMode = "auto" | "confirm" | "deny";
export type Confirm = "click" | "acknowledge" | "typed";

// every kind of change the assistant can make, grouped the way an admin thinks about them
export const POLICY_ACTIONS = {
  "workorder.create": { label: "Create work orders", risk: 2, help: "Files a maintenance request; managers (and anyone auto-assigned) are notified." },
  "workorder.assign": { label: "Assign work orders", risk: 2, help: "Assigns staff or an approved vendor, who is notified." },
  "workorder.update": { label: "Update work orders", risk: 2, help: "Changes status or adds notes. Cancelling a request always needs explicit confirmation." },
  "task.create": { label: "Create tasks", risk: 2, help: "Internal tasks for staff." },
  "inspection.schedule": { label: "Schedule inspections", risk: 2, help: "Adds an inspection from a template." },
  "booking.manage": { label: "Book and cancel amenities", risk: 2, help: "Runs the same booking rules as the booking page; fees and deposits are shown first." },
  "package.log": { label: "Log packages", risk: 2, help: "Records a delivery; the unit's residents get a pickup notification." },
  "visitor.register": { label: "Register visitors", risk: 2, help: "Pre-registers a guest or contractor." },
  "incident.create": { label: "Report incidents", risk: 2, help: "Files an incident report; staff are notified by severity." },
  "communication.send": { label: "Send announcements and messages", risk: 3, help: "Anything residents read. Always shown as a draft first — this can't be set to run on its own." },
} as const satisfies Record<string, { label: string; risk: RiskClass; help: string }>;

export type PolicyKey = keyof typeof POLICY_ACTIONS;
export const POLICY_KEYS = Object.keys(POLICY_ACTIONS) as PolicyKey[];
export const isPolicyKey = (v: string): v is PolicyKey => v in POLICY_ACTIONS;

export type PolicyRule = { action: string; propertyId: string | null; mode: PolicyMode };

export const DEFAULT_MODE: PolicyMode = "confirm";

// class 2–3 need one click, 4 an explicit acknowledgement, 5 typing a confirmation word
export function confirmFor(risk: RiskClass): Confirm {
  return risk >= 5 ? "typed" : risk === 4 ? "acknowledge" : "click";
}

// rules can make the assistant stricter freely; they can only let class-2 actions run without asking
export function validateMode(key: PolicyKey, mode: PolicyMode): string | null {
  if (mode === "auto" && POLICY_ACTIONS[key].risk >= 3) return `${POLICY_ACTIONS[key].label} always needs someone to confirm.`;
  return null;
}

export type Decision = { mode: PolicyMode; confirm: Confirm; reason: string };

// most specific rule wins per action (property over organization over default); the strictest action wins overall
export function decide(input: { riskClass: RiskClass; keys: PolicyKey[]; propertyId: string | null; rules: PolicyRule[] }): Decision {
  const rank: Record<PolicyMode, number> = { auto: 0, confirm: 1, deny: 2 };
  let mode: PolicyMode = "auto";
  let reason = "";
  for (const key of input.keys.length ? input.keys : (["task.create"] as PolicyKey[])) {
    const prop = input.propertyId ? input.rules.find((r) => r.action === key && r.propertyId === input.propertyId) : undefined;
    const org = input.rules.find((r) => r.action === key && r.propertyId === null);
    const rule = prop ?? org;
    const m = rule?.mode ?? DEFAULT_MODE;
    if (rank[m] >= rank[mode]) {
      mode = m;
      reason = `${POLICY_ACTIONS[key].label}: ${m === "auto" ? "runs on its own" : m === "deny" ? "not allowed for the assistant" : "asks first"} (${rule ? (prop ? "property rule" : "organization rule") : "default"})`;
    }
  }
  // hard limits no rule can loosen
  if (mode === "auto" && input.riskClass >= 3) {
    mode = "confirm";
    reason = "Contacts people or has a bigger impact, so it always asks first";
  }
  return { mode, confirm: confirmFor(input.riskClass), reason };
}

export const RISK_LABEL: Record<RiskClass, string> = {
  1: "Read only", 2: "Internal change", 3: "Contacts people", 4: "High impact", 5: "Irreversible",
};
