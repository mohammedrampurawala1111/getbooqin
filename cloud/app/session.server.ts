import { redirect } from "react-router";
import { createClerkClient } from "@clerk/react-router/server";
import {
  buildLogoutCookie,
  buildSessionCookie,
  createSessionToken,
  resolveTenantSession,
  prisma,
  type TenantSession,
} from "getbooqin-core";

// Thin Request/Response-shaped wrapper. The TenantSession half (which store
// a logged-in user is acting as) is unchanged — still core's
// framework-agnostic, HMAC-signed `gb_session` cookie. Identity
// (getUserSession/requireUserSession below) is now backed by Clerk instead
// of core's own password/cookie code.

export function getTenantSession(request: Request): Promise<TenantSession | null> {
  return resolveTenantSession(request.headers.get("Cookie"));
}

export function tenantSelectHeaders(session: TenantSession): Headers {
  const headers = new Headers();
  headers.append("Set-Cookie", buildSessionCookie(createSessionToken(session)));
  return headers;
}

export function tenantLogoutHeaders(): Headers {
  const headers = new Headers();
  headers.append("Set-Cookie", buildLogoutCookie());
  return headers;
}

export function getClerkClient() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error("CLERK_SECRET_KEY is not set");
  return createClerkClient({ secretKey, publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY });
}

export interface UserSession {
  userId: string;
}

// Verifies Clerk's own session cookie directly from the raw request via
// @clerk/backend's authenticateRequest (re-exported through
// @clerk/react-router/server) — deliberately not Clerk's newer
// getAuth()/clerkMiddleware() pair, which needs React Router's
// middleware/context wiring threaded through every loader and action that
// calls it. Keeping this Request-in/plain-object-out means every existing
// getUserSession(request)/requireUserSession(request) call site is
// unaffected by this swap.
export async function getUserSession(request: Request): Promise<UserSession | null> {
  const requestState = await getClerkClient().authenticateRequest(request);
  const userId = requestState.toAuth()?.userId;
  return userId ? { userId } : null;
}

export async function requireUserSession(request: Request): Promise<UserSession> {
  const session = await getUserSession(request);
  if (!session) {
    throw redirect("/login");
  }
  return session;
}

// Connection.userId is a hard FK against User — webhooks.clerk.tsx's
// user.created event is the normal way that row gets created, but it's an
// async webhook, not part of the signup request itself, and signup.tsx only
// forces the issue by calling dashboard/profile-phone when a phone number
// was entered (the Google OAuth path never calls it at all). A user who
// reaches a Connection-creating action before that webhook lands — or never
// lands, e.g. if the webhook isn't registered against whichever Clerk
// instance is live — hits a P2003 foreign key violation and can't finish
// onboarding. Call this immediately before any Connection.create() so the
// row is guaranteed to exist by then, regardless of webhook timing.
export async function ensureUserRow(userId: string): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (existing) return;

  const clerkUser = await getClerkClient().users.getUser(userId);
  const email =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    "";
  await prisma.user.upsert({ where: { id: userId }, create: { id: userId, email }, update: {} });
}
