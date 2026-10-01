import type { Tone } from "./labels";

// display labels + tones for operations records
export const WO_STATUS: Record<string, { label: string; tone: Tone }> = {
  new: { label: "New", tone: "accent" }, acknowledged: { label: "Acknowledged", tone: "accent" }, assigned: { label: "Assigned", tone: "neutral" },
  scheduled: { label: "Scheduled", tone: "neutral" }, in_progress: { label: "In progress", tone: "warning" }, awaiting_vendor: { label: "Awaiting vendor", tone: "warning" },
  awaiting_resident: { label: "Awaiting resident", tone: "warning" }, completed: { label: "Completed", tone: "success" }, closed: { label: "Closed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
export const PRIORITY: Record<string, { label: string; tone: Tone }> = {
  urgent: { label: "Urgent", tone: "danger" }, high: { label: "High", tone: "warning" }, normal: { label: "Normal", tone: "neutral" }, low: { label: "Low", tone: "neutral" },
};
export const WO_CATEGORY: Record<string, string> = {
  plumbing: "Plumbing", electrical: "Electrical", hvac: "Heating & cooling", appliance: "Appliance", elevator: "Elevator", doors_locks: "Doors & locks",
  pest: "Pests", cleaning: "Cleaning", structural: "Structural", exterior: "Exterior", fire_safety: "Fire & life safety", parking: "Parking", general: "Other / not sure",
};
export const TRANSITION_LABEL: Record<string, string> = {
  acknowledged: "Acknowledge", assigned: "Mark assigned", scheduled: "Mark scheduled", in_progress: "Start work", awaiting_vendor: "Waiting on vendor",
  awaiting_resident: "Waiting on resident", completed: "Complete", closed: "Close", cancelled: "Cancel request", new: "Reset to new",
};
export const TASK_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "accent" }, in_progress: { label: "In progress", tone: "warning" }, blocked: { label: "Blocked", tone: "danger" },
  done: { label: "Done", tone: "success" }, cancelled: { label: "Cancelled", tone: "neutral" },
};
export const INSPECTION_STATUS: Record<string, { label: string; tone: Tone }> = {
  scheduled: { label: "Scheduled", tone: "accent" }, in_progress: { label: "In progress", tone: "warning" }, completed: { label: "Completed", tone: "success" }, cancelled: { label: "Cancelled", tone: "neutral" },
};
export const INSPECTION_KIND: Record<string, string> = { unit: "Unit", property: "Property", equipment: "Equipment", safety: "Safety", move_in: "Move-in / out", move_out: "Move-out", amenity: "Amenity" };
export const SEVERITY: Record<string, { label: string; tone: Tone }> = {
  low: { label: "Low", tone: "neutral" }, medium: { label: "Medium", tone: "warning" }, high: { label: "High", tone: "danger" }, critical: { label: "Critical", tone: "danger" },
};
export const INCIDENT_TYPE: Record<string, string> = {
  security: "Security", water_damage: "Water damage", fire: "Fire-related", equipment_failure: "Equipment failure", resident: "Resident incident",
  injury: "Injury", property_damage: "Property damage", unauthorized_access: "Unauthorized access", other: "Other",
};
export const INCIDENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "danger" }, investigating: { label: "Investigating", tone: "warning" }, resolved: { label: "Resolved", tone: "success" }, closed: { label: "Closed", tone: "neutral" },
};
export const COMPLAINT_CATEGORY: Record<string, string> = {
  noise: "Noise", parking: "Parking", pets: "Pets", smoking: "Smoking", cleanliness: "Cleanliness", neighbour: "Neighbour", amenity: "Amenity", staff: "Staff", maintenance: "Maintenance", other: "Other",
};
export const COMPLAINT_STATUS: Record<string, { label: string; tone: Tone }> = {
  new: { label: "New", tone: "accent" }, acknowledged: { label: "Acknowledged", tone: "accent" }, investigating: { label: "Investigating", tone: "warning" },
  resolved: { label: "Resolved", tone: "success" }, closed: { label: "Closed", tone: "neutral" }, dismissed: { label: "Dismissed", tone: "neutral" },
};
