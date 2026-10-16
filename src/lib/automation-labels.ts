import type { Tone } from "./labels";

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "accent" }, waiting_approval: { label: "Waiting for approval", tone: "warning" }, completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" }, rejected: { label: "Declined", tone: "neutral" },
};
export const STEP_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Not run yet", tone: "neutral" }, done: { label: "Done", tone: "success" }, skipped: { label: "Skipped", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" }, waiting: { label: "Waiting", tone: "warning" },
};
