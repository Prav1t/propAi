import { authenticator } from "otplib";
import { createHash, randomInt } from "node:crypto";

// RFC 6238, 30s step, ±1 step drift tolerance
authenticator.options = { window: 1, step: 30, digits: 6 };

export function newTotpSecret(): string {
  return authenticator.generateSecret(20);
}

export function totpUri(secret: string, email: string, issuer: string): string {
  return authenticator.keyuri(email, issuer, secret);
}

export function verifyTotp(code: string, secret: string): boolean {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  try {
    return authenticator.check(clean, secret);
  } catch {
    return false;
  }
}

// the 30-second time step a valid code belongs to (null when invalid); a step is accepted once per user, so a
// code that was seen (shoulder-surfed, phished, logged) can't be replayed within its validity window
export function totpStep(code: string, secret: string, now = Date.now()): number | null {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  try {
    const delta = authenticator.checkDelta(clean, secret);
    return delta === null ? null : Math.floor(now / 30_000) + delta;
  } catch {
    return null;
  }
}

export function currentTotp(secret: string): string {
  return authenticator.generate(secret);
}

// recovery codes like "k3f9-2mzq-8hta"; stored hashed
export function newRecoveryCodes(n = 10): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: n }, () => {
    const chars = Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join(""); // unbiased
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}
