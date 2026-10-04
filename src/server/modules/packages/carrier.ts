// best-effort carrier detection from a tracking number (staff can always override)
export const CARRIERS = ["Canada Post", "Purolator", "UPS", "FedEx", "DHL", "USPS", "Amazon", "Intelcom", "Other"] as const;

export function normalizeTracking(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, "").slice(0, 60);
}

export function detectCarrier(raw: string): { carrier: string; confident: boolean } | null {
  const t = normalizeTracking(raw);
  if (!t) return null;
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return { carrier: "UPS", confident: true };
  if (/^TBA\d{12}$/.test(t)) return { carrier: "Amazon", confident: true };
  if (/^INTL[A-Z0-9]{8,}$/.test(t)) return { carrier: "Intelcom", confident: false };
  // UPU S10 international format: two letters, 9 digits, country code
  const s10 = /^[A-Z]{2}\d{9}([A-Z]{2})$/.exec(t);
  if (s10) return { carrier: s10[1] === "CA" ? "Canada Post" : s10[1] === "US" ? "USPS" : "Other", confident: s10[1] === "CA" || s10[1] === "US" };
  if (/^9[1-5]\d{18,20}$/.test(t)) return { carrier: "USPS", confident: true };
  if (/^\d{16}$/.test(t)) return { carrier: "Canada Post", confident: true };
  if (/^\d{15}$/.test(t)) return { carrier: "FedEx", confident: true };
  if (/^\d{12}$/.test(t)) return { carrier: "FedEx", confident: false }; // also Purolator PINs
  if (/^\d{10}$/.test(t)) return { carrier: "DHL", confident: false };
  return null;
}
