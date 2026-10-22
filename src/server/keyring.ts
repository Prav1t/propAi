import { ciphertextKeyId, decryptWithKeys, encryptWithKeyId } from "./auth/crypto";
import { env } from "./env";

// Secrets at rest (MFA secrets, webhook signing secrets, integration and SSO credentials) are sealed with the current
// key, APP_ENCRYPTION_KEY, named APP_ENCRYPTION_KEY_ID. To rotate: move the old key into APP_ENCRYPTION_OLD_KEYS
// ("k1:<base64>"), set a new APP_ENCRYPTION_KEY and APP_ENCRYPTION_KEY_ID, deploy, then run `npm run keys:rotate`,
// which re-seals everything with the new key. Once it reports nothing left on the old key, remove it.
export type Keyring = { currentId: string; keys: Map<string, string> };

export function keyring(e = env()): Keyring {
  const keys = new Map<string, string>([[e.APP_ENCRYPTION_KEY_ID, e.APP_ENCRYPTION_KEY]]);
  for (const entry of (e.APP_ENCRYPTION_OLD_KEYS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = entry.indexOf(":");
    keys.set(entry.slice(0, i), entry.slice(i + 1));
  }
  return { currentId: e.APP_ENCRYPTION_KEY_ID, keys };
}

export function seal(plaintext: string, ring = keyring()): string {
  return encryptWithKeyId(plaintext, ring.currentId, ring.keys.get(ring.currentId)!);
}

export function unseal(payload: string, ring = keyring()): string {
  return decryptWithKeys(payload, (id) => ring.keys.get(id));
}

// true when the value should be re-sealed with the current key
export function needsReseal(payload: string, ring = keyring()): boolean {
  return ciphertextKeyId(payload) !== ring.currentId || payload.startsWith("v1.");
}
