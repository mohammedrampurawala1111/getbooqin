import { createHmac, timingSafeEqual } from "node:crypto";
import prisma from "../db.js";

// A tenant-scoped session, resolved either from a Shopify OAuth session
// (embedded admin, today) or from a standalone User's Connection (this
// module, for the new app surface in Prompt 2). Both shapes expose `shop`
// so admin route loaders can keep doing `const { session } = await
// resolve(...); const shop = session.shop;` unchanged — see
// docs/plan/tenant-session-design.md.
export interface TenantSession {
  shop: string;
  platform: string;
  userId: string;
  connectionId: string;
}

export const SESSION_COOKIE_NAME = "gb_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSigningSecret(): string {
  const secret = process.env.SESSION_SIGNING_SECRET;
  if (!secret) {
    throw new Error("SESSION_SIGNING_SECRET is not set");
  }
  return secret;
}

function sign(data: string): string {
  return createHmac("sha256", getSigningSecret()).update(data).digest("base64url");
}

// Generic stateless, HMAC-signed token primitive — no server-side session
// table to join on every request. TenantSession and the OAuth connect-flow
// state param (src/platforms/shopify.ts) are both just payloads signed with
// this.
export function signPayload<T extends object>(payload: T, ttlMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }), "utf8").toString("base64url");
  const signature = sign(body);
  return `${body}.${signature}`;
}

export function verifySignedPayload<T>(token: string): (T & { exp: number }) | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Stateless, HMAC-signed token — revocation still works without a session
// table: verify() re-checks the Connection row's status, so revoking a
// Connection invalidates every token derived from it immediately, without
// needing to track/expire individual tokens.
export function createSessionToken(session: TenantSession): string {
  return signPayload(session, SESSION_TTL_MS);
}

function decodeToken(token: string): (TenantSession & { exp: number }) | null {
  return verifySignedPayload<TenantSession>(token);
}

// Verifies the token's signature/expiry and that the underlying Connection
// is still active — a revoked or deleted Connection ends the session even
// if the signed token itself hasn't expired.
export async function verifySessionToken(token: string): Promise<TenantSession | null> {
  const payload = decodeToken(token);
  if (!payload) return null;

  const connection = await prisma.connection.findUnique({ where: { id: payload.connectionId } });
  if (!connection || connection.status !== "active" || connection.userId !== payload.userId) {
    return null;
  }

  return {
    shop: connection.shop,
    platform: connection.platform,
    userId: connection.userId,
    connectionId: connection.id,
  };
}

// Secure requires HTTPS — real browsers silently drop the Set-Cookie
// otherwise, which would break login on plain http://localhost dev servers.
// Deployed environments must set NODE_ENV=production so this comes back on.
function secureAttr(): string {
  return process.env.NODE_ENV === "production" ? " Secure;" : "";
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawVal] = part.trim().split("=");
    if (!rawKey) continue;
    out[rawKey] = decodeURIComponent(rawVal.join("="));
  }
  return out;
}

// Resolves a tenant session from a raw `Cookie` header value — deliberately
// framework-agnostic (no dependency on Express/Fetch Request/etc.) so it
// can be adopted by whatever HTTP layer the standalone app surface (Prompt
// 2) ends up using.
export async function resolveTenantSession(cookieHeader: string | null | undefined): Promise<TenantSession | null> {
  if (!cookieHeader) return null;
  const token = parseCookies(cookieHeader)[SESSION_COOKIE_NAME];
  if (!token) return null;
  return verifySessionToken(token);
}

export function buildSessionCookie(token: string): string {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly;${secureAttr()} SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function buildLogoutCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly;${secureAttr()} SameSite=Lax; Max-Age=0`;
}

// Standalone-app identity ("logged into cloud at all", independent of any
// particular connected store) is handled by Clerk now, not here — see
// cloud/app/session.server.ts's getUserSession/requireUserSession.
