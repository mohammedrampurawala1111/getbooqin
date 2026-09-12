import { data } from "react-router";
import { AdminAccess } from "getbooqin-core";
import { requireUserSession, getClerkClient } from "~/session.server";

/**
 * The guard for every /admin route.
 *
 * Throws **404, not 403**. A 403 confirms the route exists and that the
 * viewer found something worth guarding; a 404 tells an unauthorised
 * visitor exactly what a nonexistent path would. There is no useful
 * distinction to draw for someone who shouldn't be here.
 *
 * /admin is deliberately outside the tenant middleware entirely — it has
 * no connectionId, it is not scoped to a business, and it must not
 * inherit any of requireTenant's assumptions.
 */
export async function requirePlatformAdmin(request: Request) {
  const session = await requireUserSession(request);

  if (!(await AdminAccess.isPlatformAdmin(session.userId))) {
    throw data("Not found", { status: 404 });
  }

  const clerkUser = await getClerkClient().users.getUser(session.userId);
  const email =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    "";

  return { userId: session.userId, email };
}

/**
 * Best-effort client IP for the audit log. Fly puts the real one in
 * Fly-Client-IP; the x-forwarded-for fallback is for local development.
 * Never trusted for anything but the record — it is attacker-supplied.
 */
export function clientIp(request: Request): string {
  return (
    request.headers.get("fly-client-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    ""
  );
}
