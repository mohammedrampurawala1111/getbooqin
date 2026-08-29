import { redirect } from "react-router";
import type { Route } from "./+types/dashboard.account";
import { listUserConnections } from "getbooqin-core";
import { requireUserSession } from "~/session.server";

// Account used to be a standalone top-level route with its own bare
// topbar — that was the actual bug behind "clicking Profile opens a
// separate view": it dropped out of the dashboard's sidebar shell
// entirely. It's real home now is dashboard.$connectionId.account.tsx,
// nested like every other screen so it renders inside that same shell.
// This route is just the redirect old links/bookmarks to bare
// /dashboard/account still need — same "most recently connected store"
// resolution /dashboard's own root route uses.
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
  const search = new URL(request.url).search;
  throw redirect(`/dashboard/${mostRecent.id}/account${search}`);
}
