import { generateToken, hashToken } from "../../auth/crypto";

// guests may be checked in this long before their window opens
export const EARLY_CHECKIN_MINUTES = 60;

// a fresh guest-pass secret; only the hash is stored
export function newPass(): { token: string; hash: string } {
  const token = generateToken(24);
  return { token, hash: hashToken(token) };
}

export const hashPass = (token: string) => hashToken(token);

// pass tokens are URL-safe base64; anything else is rejected before touching the database
export const looksLikePassToken = (t: string) => /^[A-Za-z0-9_-]{24,64}$/.test(t);

// pulls the token out of a scanned QR (full pass URL) or typed text
export function tokenFromScan(raw: string): string | null {
  const s = raw.trim();
  const m = /\/pass\/([A-Za-z0-9_-]{24,64})(?:[/?#]|$)/.exec(s);
  const t = m ? m[1] : s;
  return looksLikePassToken(t) ? t : null;
}

export type VisitorWindow = { status: string; expectedFrom: Date; expectedUntil: Date };
export type PassState = "upcoming" | "valid" | "on_site" | "expired" | "used" | "cancelled" | "denied";

export function passState(v: VisitorWindow, now = new Date()): PassState {
  if (v.status === "cancelled") return "cancelled";
  if (v.status === "denied") return "denied";
  if (v.status === "checked_out") return "used";
  if (v.status === "checked_in") return "on_site";
  if (now.getTime() < v.expectedFrom.getTime() - EARLY_CHECKIN_MINUTES * 60_000) return "upcoming";
  if (now > v.expectedUntil) return "expired";
  return "valid";
}

// guests still on site after their window
export const isOverstay = (v: VisitorWindow, now = new Date()) => v.status === "checked_in" && now > v.expectedUntil;
