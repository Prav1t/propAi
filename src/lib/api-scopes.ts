// What an API key can be allowed to do (Iteration 10). Each scope is one of the app's own permissions, so a key can
// never do more than the person who created it — the key is checked against both on every request.
export const API_SCOPES = [
  { perm: "property.read", label: "Properties and buildings", access: "read" },
  { perm: "unit.read", label: "Units", access: "read" },
  { perm: "resident.read", label: "Residents (names and contact details)", access: "read" },
  { perm: "workorder.read", label: "Work orders", access: "read" },
  { perm: "workorder.create", label: "Work orders", access: "create" },
  { perm: "workorder.manage", label: "Work orders", access: "change status, assign" },
  { perm: "vendor.read", label: "Vendors", access: "read" },
  { perm: "incident.read", label: "Incidents", access: "read" },
  { perm: "incident.create", label: "Incidents", access: "create" },
  { perm: "complaint.read", label: "Complaints", access: "read" },
  { perm: "booking.manage", label: "Amenity bookings", access: "read" },
  { perm: "package.manage", label: "Packages", access: "read" },
] as const;

export type ApiScope = (typeof API_SCOPES)[number]["perm"];
export const API_SCOPE_PERMS: readonly string[] = API_SCOPES.map((s) => s.perm);
export const isApiScope = (v: string): v is ApiScope => API_SCOPE_PERMS.includes(v);
