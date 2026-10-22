import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

// 256-bit random token, url-safe
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// tokens are stored only as sha256 hashes
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// AES-256-GCM authenticated encryption; output = v1.iv.tag.ciphertext (base64url). New code uses the keyring
// (seal/unseal in ../keyring.ts), which writes v2 ciphertexts that name their key.
export function encrypt(plaintext: string, keyB64: string): string {
  const key = Buffer.from(keyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(payload: string, keyB64: string): string {
  const [version, iv, tag, ct] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported ciphertext");
  const key = Buffer.from(keyB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

// v2: like v1 but names the key it was made with ("v2.<keyId>.iv.tag.ciphertext"), so keys can be rotated.
// The key id is bound to the ciphertext as additional authenticated data: relabelling it breaks decryption.
export function encryptWithKeyId(plaintext: string, keyId: string, keyB64: string): string {
  const key = Buffer.from(keyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`v2.${keyId}`));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v2", keyId, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

// which key a ciphertext needs: v1 predates key ids and was made with the first key ("k1")
export function ciphertextKeyId(payload: string): string | null {
  const parts = payload.split(".");
  if (parts[0] === "v1" && parts.length === 4) return "k1";
  if (parts[0] === "v2" && parts.length === 5) return parts[1];
  return null;
}

export function decryptWithKeys(payload: string, keyFor: (keyId: string) => string | undefined): string {
  const keyId = ciphertextKeyId(payload);
  if (!keyId) throw new Error("Unsupported ciphertext");
  const keyB64 = keyFor(keyId);
  if (!keyB64) throw new Error(`Encryption key "${keyId}" isn't configured`);
  if (payload.startsWith("v1.")) return decrypt(payload, keyB64);
  const [, , iv, tag, ct] = payload.split(".");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(`v2.${keyId}`));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
