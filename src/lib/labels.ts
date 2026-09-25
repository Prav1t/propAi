// display labels and badge tones shared across pages
export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export const PROPERTY_TYPE_LABEL: Record<string, string> = {
  residential: "Residential", commercial: "Commercial", mixed_use: "Mixed use", strata: "Strata", rental: "Rental", industrial: "Industrial",
};
export const UNIT_STATUS: Record<string, { label: string; tone: Tone }> = {
  occupied: { label: "Occupied", tone: "success" }, vacant: { label: "Vacant", tone: "neutral" }, notice: { label: "Notice given", tone: "warning" },
  renovation: { label: "Renovation", tone: "accent" }, unavailable: { label: "Unavailable", tone: "danger" },
};
export const UNIT_TYPE_LABEL: Record<string, string> = { residential: "Residential", commercial: "Commercial", storage: "Storage", amenity: "Amenity", other: "Other" };
export const RELATIONSHIP_LABEL: Record<string, string> = { resident: "Resident", tenant: "Tenant", owner: "Owner", occupant: "Occupant" };
export const VENDOR_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" }, inactive: { label: "Inactive", tone: "neutral" }, blocked: { label: "Blocked", tone: "danger" },
};
export const EMPLOYMENT_LABEL: Record<string, string> = { full_time: "Full-time", part_time: "Part-time", contract: "Contract", on_call: "On call" };

export const cat = (c: string) => c.replace(/_/g, " ").replace(/^\w/, (x) => x.toUpperCase());
export const opts = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }));

export const TIMEZONE_OPTIONS = [
  "America/Vancouver", "America/Edmonton", "America/Regina", "America/Winnipeg", "America/Toronto", "America/Halifax",
  "America/St_Johns", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "Europe/London", "UTC",
].map((t) => ({ value: t, label: t.replace("_", " ") }));

// days until a date (negative when past); null for missing
export function daysUntil(date: string | null): number | null {
  if (!date) return null;
  return Math.ceil((new Date(`${date}T00:00:00Z`).getTime() - Date.now()) / 86_400_000);
}
