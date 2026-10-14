import type { Tone } from "./labels";

export const AMENITY_KIND: Record<string, string> = {
  gym: "Gym", party_room: "Party room", pool: "Pool", rooftop: "Rooftop", meeting_room: "Meeting room", lounge: "Lounge", court: "Court",
  workspace: "Workspace", guest_suite: "Guest suite", bbq: "BBQ area", theatre: "Theatre", other: "Other",
};
export const BOOKING_STATUS: Record<string, { label: string; tone: Tone }> = {
  requested: { label: "Awaiting approval", tone: "warning" }, approved: { label: "Confirmed", tone: "success" },
  declined: { label: "Declined", tone: "danger" }, cancelled: { label: "Cancelled", tone: "neutral" },
};
export const FEE_STATUS: Record<string, string> = { none: "No fee", due: "Fee due", paid: "Fee paid", waived: "Fee waived" };
export const DEPOSIT_STATUS: Record<string, string> = { none: "No deposit", due: "Deposit due", held: "Deposit held", refunded: "Deposit refunded", withheld: "Deposit withheld" };
export const PACKAGE_STATUS: Record<string, { label: string; tone: Tone }> = {
  waiting: { label: "Waiting", tone: "accent" }, picked_up: { label: "Picked up", tone: "success" }, returned: { label: "Returned", tone: "neutral" },
};
export const PACKAGE_SIZE: Record<string, string> = { envelope: "Envelope", small: "Small", medium: "Medium", large: "Large", oversize: "Oversize" };
export const ANNOUNCEMENT_CATEGORY: Record<string, { label: string; tone: Tone }> = {
  general: { label: "General", tone: "neutral" }, maintenance: { label: "Maintenance", tone: "accent" }, event: { label: "Event", tone: "success" },
  policy: { label: "Policy", tone: "neutral" }, emergency: { label: "Urgent", tone: "danger" },
};
export const ANNOUNCEMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" }, scheduled: { label: "Scheduled", tone: "accent" }, published: { label: "Published", tone: "success" }, archived: { label: "Archived", tone: "neutral" },
};
export const AUDIENCE: Record<string, string> = { everyone: "Residents and staff", residents: "Residents only", staff: "Staff only" };
export const THREAD_CATEGORY: Record<string, string> = {
  general: "General", maintenance: "Maintenance", amenities: "Amenities", parking: "Parking", packages: "Packages", billing: "Billing", other: "Other",
};
export const DOCUMENT_CATEGORY: Record<string, string> = {
  bylaws: "Bylaws", rules: "Rules", policy: "Policies", minutes: "Minutes", notice: "Notices", insurance: "Insurance", manual: "Manuals",
  lease: "Leases", form: "Forms", financial: "Financial", other: "Other",
};
export const DOCUMENT_AUDIENCE: Record<string, string> = { staff: "Staff only", residents: "Residents", owners: "Owners only" };
export const money = (cents: number) => `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const fileSize = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1000))} KB`);

export const KNOWLEDGE_CATEGORY: Record<string, string> = {
  rules: "House rules", amenities: "Amenities", procedures: "Procedures", emergency: "Emergencies", maintenance: "Maintenance",
  moving: "Moving in & out", parking: "Parking", policy: "Policies", general: "General",
};
export const INDEX_STATUS: Record<string, { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  queued: { label: "Queued", tone: "neutral" }, indexing: { label: "Indexing", tone: "accent" }, indexed: { label: "Indexed", tone: "success" },
  failed: { label: "Failed", tone: "danger" }, unsupported: { label: "Can't read", tone: "warning" }, empty: { label: "No text", tone: "warning" },
};
