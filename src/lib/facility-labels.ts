import type { Tone } from "./labels";

export const VISITOR_KIND: Record<string, string> = { guest: "Guest", delivery: "Delivery", contractor: "Contractor", service: "Service provider", other: "Other" };
export const VISITOR_STATUS: Record<string, { label: string; tone: Tone }> = {
  expected: { label: "Expected", tone: "accent" }, checked_in: { label: "On site", tone: "success" }, checked_out: { label: "Left", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" }, denied: { label: "Turned away", tone: "danger" },
};
export const PASS_STATE: Record<string, { label: string; tone: Tone }> = {
  upcoming: { label: "Not valid yet", tone: "neutral" }, valid: { label: "Valid now", tone: "success" }, on_site: { label: "Checked in", tone: "success" },
  expired: { label: "Expired", tone: "warning" }, used: { label: "Used", tone: "neutral" }, cancelled: { label: "Cancelled", tone: "neutral" }, denied: { label: "Turned away", tone: "danger" },
};
export const SPACE_KIND: Record<string, string> = { resident: "Resident", visitor: "Visitor", accessible: "Accessible", ev: "EV charging", loading: "Loading", motorcycle: "Motorcycle", reserved: "Reserved" };
export const PERMIT_KIND: Record<string, string> = { resident: "Resident", visitor: "Visitor", contractor: "Contractor", staff: "Staff" };
export const PERMIT_STATE: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" }, scheduled: { label: "Starts later", tone: "accent" }, expired: { label: "Expired", tone: "neutral" }, revoked: { label: "Revoked", tone: "danger" },
};
export const VIOLATION_KIND: Record<string, string> = {
  no_permit: "No permit", expired_permit: "Expired permit", wrong_space: "Wrong space", visitor_overstay: "Visitor overstay", fire_lane: "Fire lane",
  accessible: "Accessible space without permit", blocking: "Blocking access", other: "Other",
};
export const VIOLATION_STATUS: Record<string, { label: string; tone: Tone }> = {
  reported: { label: "To review", tone: "warning" }, confirmed: { label: "Confirmed", tone: "accent" }, dismissed: { label: "Dismissed", tone: "neutral" },
  warned: { label: "Notice issued", tone: "danger" }, resolved: { label: "Resolved", tone: "success" },
};
export const VIOLATION_SOURCE: Record<string, string> = { staff: "Staff report", resident: "Resident report", detection: "Camera detection" };
export const SHIFT_POSITION: Record<string, string> = { front_desk: "Front desk", security: "Security", maintenance: "Maintenance", cleaning: "Cleaning", management: "Management", other: "Other" };
export const ASSET_CATEGORY: Record<string, string> = {
  hvac: "HVAC", elevator: "Elevator", plumbing: "Plumbing", electrical: "Electrical", fire_safety: "Fire & life safety", roofing: "Roofing", security: "Security",
  generator: "Generator", pool: "Pool & spa", appliance: "Appliance", doors_access: "Doors & access", other: "Other",
};
export const ASSET_STATUS: Record<string, { label: string; tone: Tone }> = {
  operational: { label: "Operational", tone: "success" }, needs_attention: { label: "Needs attention", tone: "warning" }, down: { label: "Out of service", tone: "danger" }, retired: { label: "Retired", tone: "neutral" },
};
export const CRITICALITY: Record<string, { label: string; tone: Tone }> = {
  low: { label: "Low", tone: "neutral" }, medium: { label: "Medium", tone: "neutral" }, high: { label: "High", tone: "warning" }, critical: { label: "Critical", tone: "danger" },
};
export const INTERVAL_UNIT: Record<string, string> = { day: "days", week: "weeks", month: "months", year: "years" };

export const hours = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${(h / 24).toFixed(1)} days`);
export const fmtPlate = (p: string) => (p.length > 3 ? `${p.slice(0, p.length - 3)} ${p.slice(-3)}` : p);
