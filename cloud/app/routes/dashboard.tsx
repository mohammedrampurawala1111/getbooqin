import { redirect } from "react-router";
import type { Route } from "./+types/dashboard";
import { listUserConnections } from "getbooqin-core";
import { requireUserSession } from "~/session.server";

// No more store-picker UI — most merchants have exactly one store, and
// switching between several now lives in Settings › Integrations
// (dashboard.$connectionId.settings.tsx's "Connected Shopify stores" card).
// This route is just the smart landing spot both /login and a bare
// /dashboard visit resolve through.
export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUserSession(request);
  const connections = await listUserConnections(session.userId);
  const active = connections.filter((c) => c.status === "active");

  if (active.length === 0) {
    throw redirect("/onboarding?step=1");
  }

  const mostRecent = [...active].sort(
    (a, b) => new Date(b.connectedAt).getTime() - new Date(a.connectedAt).getTime()
  )[0];
  throw redirect(`/dashboard/${mostRecent.id}`);
}
