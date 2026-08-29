import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { tenantLogoutHeaders } from "~/session.server";

// Reached after the client-side Clerk signOut() (see dashboard.tsx's
// LogoutButton) has already ended the identity session — this loader's only
// job is clearing the leftover gb_session (TenantSession) cookie so a stale
// store selection doesn't survive the logout.
//
// Also exported as an action: older cached JS bundles (any tab open before
// a deploy that touched the logout trigger) may still POST here as a plain
// <form>, and with no action this 405s with an unhandled router error and
// no error boundary in root.tsx to catch it — a broken logout that looks
// like the whole app is down. Keep both handlers doing the same thing so
// it's safe regardless of which client version is asking.
export async function loader({}: Route.LoaderArgs) {
  return redirect("/login", { headers: tenantLogoutHeaders() });
}

export async function action({}: Route.ActionArgs) {
  return redirect("/login", { headers: tenantLogoutHeaders() });
}
