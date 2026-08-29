import { randomBytes } from "node:crypto";

/** Current UTC instant. Kept as a named helper so call sites read like the PHP `Db::now()`. */
export function now(): Date {
  return new Date();
}

/** A public, unguessable token — booking UIDs, chat conversation UIDs. */
export function uid(): string {
  return randomBytes(24)
    .toString("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 24);
}
