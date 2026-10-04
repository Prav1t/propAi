// licence plates are compared on letters and digits only, upper-case ("abc-123" = "ABC 123")
export function normalizePlate(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
}

// 2–8 characters covers North American and most European formats
export const isPlausiblePlate = (plate: string) => /^[A-Z0-9]{2,8}$/.test(plate);

export type PermitLike = { status: string; validFrom: Date; validUntil: Date | null };

// a permit's state at a moment in time
export function permitState(p: PermitLike, now = new Date()): "active" | "scheduled" | "expired" | "revoked" {
  if (p.status === "revoked") return "revoked";
  if (p.validFrom > now) return "scheduled";
  if (p.validUntil && p.validUntil <= now) return "expired";
  return "active";
}
