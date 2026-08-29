import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Encrypts Connection.credentials (a platform access token) at rest.
// AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt
// rather than silently returning garbage.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey(): Buffer {
  const raw = process.env.CONNECTION_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("CONNECTION_ENCRYPTION_KEY is not set");
  }
  const key = raw.includes("/") || raw.includes("+") || raw.length % 4 === 0
    ? Buffer.from(raw, "base64")
    : Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("CONNECTION_ENCRYPTION_KEY must decode to 32 bytes (base64 or hex)");
  }
  return key;
}

export function encryptCredentials(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64")).join(".");
}

export function decryptCredentials(stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("malformed encrypted credentials");
  }
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
