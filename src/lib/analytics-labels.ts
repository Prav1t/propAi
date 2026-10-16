// Labels and scoring rules for analytics (Iteration 9), shared by pages, settings and the assistant. No I/O.

export const HEALTH_FACTORS = ["sla", "response", "overdue", "backlog", "complaints", "incidents", "inspections", "availability"] as const;
export type HealthFactor = (typeof HEALTH_FACTORS)[number];

// how each factor is turned into a 0–100 score; the thresholds are fixed and documented, the weights are configurable
export const HEALTH_FACTOR_INFO: Record<HealthFactor, { label: string; measures: string; scoring: string }> = {
  sla: { label: "Resolved within SLA", measures: "Requests completed in the last 30 days that met their resolution target", scoring: "Score = the percentage met." },
  response: { label: "Responded within SLA", measures: "Requests created in the last 30 days that got a first response by the response target", scoring: "Score = the percentage met." },
  overdue: { label: "Overdue backlog", measures: "Share of open requests that are past their resolution target right now", scoring: "Score = 100 − the overdue share (no open requests scores 100)." },
  backlog: { label: "Open backlog", measures: "Open requests per 100 units right now", scoring: "Score falls by 3 for each open request per 100 units (34 or more scores 0)." },
  complaints: { label: "Complaints", measures: "Complaints in the last 30 days per 100 units", scoring: "Score falls by 10 for each complaint per 100 units (10 or more scores 0)." },
  incidents: { label: "Serious incidents", measures: "High or critical incidents in the last 30 days", scoring: "Score falls by 25 for each one (4 or more scores 0)." },
  inspections: { label: "Inspection failures", measures: "Share of inspections completed in the last 90 days that failed", scoring: "Score = 100 − the failure rate." },
  availability: { label: "Equipment availability", measures: "Share of equipment hours in service over the last 30 days", scoring: "Score = the availability percentage." },
};

export const DEFAULT_HEALTH_WEIGHTS: Record<HealthFactor, number> = { sla: 25, response: 15, overdue: 20, backlog: 10, complaints: 10, incidents: 10, inspections: 5, availability: 5 };

export type HealthGrade = "good" | "fair" | "poor";
export const healthGrade = (score: number | null): HealthGrade | null => (score === null ? null : score >= 80 ? "good" : score >= 60 ? "fair" : "poor");
export const HEALTH_GRADE: Record<HealthGrade, { label: string; tone: "success" | "warning" | "danger" }> = {
  good: { label: "Healthy", tone: "success" }, fair: { label: "Watch", tone: "warning" }, poor: { label: "Needs attention", tone: "danger" },
};

const clamp = (v: number) => Math.max(0, Math.min(100, v));

// raw factor value → 0–100 (pure; unit-tested)
export function scoreFactor(f: HealthFactor, value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  switch (f) {
    case "sla": case "response": case "availability": return Math.round(clamp(value));
    case "overdue": case "inspections": return Math.round(clamp(100 - value));
    case "backlog": return Math.round(clamp(100 - value * 3));
    case "complaints": return Math.round(clamp(100 - value * 10));
    case "incidents": return Math.round(clamp(100 - value * 25));
  }
}

// weighted average over the factors that have data; weights of missing factors are left out, not counted as zero
export function combineHealth(parts: { factor: HealthFactor; score: number | null; weight: number }[]) {
  const used = parts.filter((p) => p.score !== null && p.weight > 0);
  const total = used.reduce((s, p) => s + p.weight, 0);
  if (!total) return { score: null, contributions: parts.map((p) => ({ ...p, points: null as number | null })) };
  const score = Math.round(used.reduce((s, p) => s + p.weight * (p.score as number), 0) / total);
  return { score, contributions: parts.map((p) => ({ ...p, points: p.score === null || p.weight <= 0 ? null : Math.round(((p.weight * p.score) / total) * 10) / 10 })) };
}
