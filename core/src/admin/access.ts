/**
 * Who may reach /admin.
 *
 * **Layered, not clever.** `User.isPlatformAdmin` (a column) AND the
 * email appearing in `PLATFORM_ADMIN_EMAILS` (an env allowlist) are
 * *both* required. A leaked session or a bad write to one column is then
 * not enough on its own, and the env var is what bootstraps the very
 * first admin — there is no chicken-and-egg where you need admin access
 * to grant admin access.
 *
 * Neither half is a substitute for the other. The column alone would
 * mean anyone who could write to the User table could promote
 * themselves; the env var alone would mean revoking someone needs a
 * deploy.
 */
import prisma from "../db.js";

export function adminEmailAllowlist(): string[] {
  return (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowlistedEmail(email: string | null | undefined): boolean {
  const allowlist = adminEmailAllowlist();
  // An empty allowlist denies everyone. The alternative — "unset means
  // open" — is the kind of default that turns a missing env var into a
  // full compromise.
  if (allowlist.length === 0) return false;
  return allowlist.includes((email ?? "").trim().toLowerCase());
}

export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, isPlatformAdmin: true },
  });
  if (!user) return false;
  return user.isPlatformAdmin && isAllowlistedEmail(user.email);
}

/**
 * Bootstraps the column half from the env half, for a user who is
 * already allowlisted. Run once, deliberately, rather than having the
 * app self-promote on sight of a matching email — that would make the
 * env var alone sufficient and collapse the two layers into one.
 */
export async function promoteAllowlistedUser(email: string): Promise<boolean> {
  if (!isAllowlistedEmail(email)) return false;
  const { count } = await prisma.user.updateMany({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    data: { isPlatformAdmin: true },
  });
  return count > 0;
}
