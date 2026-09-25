import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";

// OWASP minimum argon2id profile: m=19 MiB, t=2, p=1
const OPTIONS = { algorithm: 2 /* Argon2id */, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

// small deny-list of the most common passwords; full breach-list check is a planned hardening step
const COMMON = new Set([
  "password", "password1", "password123", "123456789", "1234567890", "qwertyuiop", "iloveyou12",
  "letmein123", "welcome123", "admin12345", "passw0rd12", "changeme12", "qwerty1234", "abc1234567",
  "football12", "baseball12", "sunshine12", "princess12", "11111111111", "0000000000",
]);

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(128, "Use at most 128 characters.")
  .refine((v) => !COMMON.has(v.toLowerCase()), "This password is too common. Choose something less predictable.")
  .refine((v) => new Set(v).size >= 5, "Use a wider variety of characters.");

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// constant-ish work when the user doesn't exist, to blunt account enumeration via timing
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(await dummyHash, password);
}
