// Meetings and motions: labels and the one rule that decides a motion. Pure, shared by server and pages.

export const MEETING_KIND: Record<string, string> = { council: "Council meeting", agm: "Annual general meeting", sgm: "Special general meeting", committee: "Committee meeting" };
export const MEETING_STATUS: Record<string, { label: string; tone: "neutral" | "success" | "danger" | "accent" }> = {
  scheduled: { label: "Scheduled", tone: "accent" }, held: { label: "Held", tone: "success" }, cancelled: { label: "Cancelled", tone: "neutral" },
};
export const MOTION_STATUS: Record<string, { label: string; tone: "neutral" | "success" | "danger" | "accent" | "warning" }> = {
  open: { label: "Open for voting", tone: "accent" }, carried: { label: "Carried", tone: "success" }, defeated: { label: "Defeated", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "neutral" }, tabled: { label: "Tabled", tone: "warning" },
};
export const THRESHOLD: Record<string, string> = { majority: "Majority of votes cast", three_quarters: "Three-quarters of votes cast", unanimous: "Unanimous" };

export type Tally = { for: number; against: number; abstain: number };

// Whether a motion carries. Abstentions are not votes cast: they count toward neither side. A motion nobody voted
// for never carries, and a tie is defeated. Which threshold a motion needs is for the people running the meeting to
// choose from their bylaws and legislation; this only does the arithmetic.
export function motionOutcome(threshold: string, t: Tally): "carried" | "defeated" {
  const cast = t.for + t.against;
  if (t.for <= 0 || cast <= 0) return "defeated";
  if (threshold === "unanimous") return t.against === 0 ? "carried" : "defeated";
  if (threshold === "three_quarters") return t.for * 4 >= cast * 3 ? "carried" : "defeated";
  return t.for > t.against ? "carried" : "defeated";
}

export const tallyText = (t: Tally) => `${t.for} for, ${t.against} against${t.abstain ? `, ${t.abstain} abstained` : ""}`;
