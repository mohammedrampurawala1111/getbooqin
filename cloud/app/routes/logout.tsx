import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { tenantLogoutHeaders } from "~/session.server";

// Reached after the client-side Clerk signOut() (see dashboard.tsx's
// LogoutButton) has already ended the identity session — this loader's only
// job is clearing the leftover gb_session (TenantSession) cookie so a stale
// store selection doesn't survive the logout.
export async function loader({}: Route.LoaderArgs) {
  return redirect("/login", { headers: tenantLogoutHeaders() });
}
