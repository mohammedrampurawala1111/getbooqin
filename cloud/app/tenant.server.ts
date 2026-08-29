import { data } from "react-router";
import { getUserConnection } from "getbooqin-core";
import { requireUserSession } from "~/session.server";

// Every screen under dashboard/:connectionId needs the same thing: prove the
// requesting user owns this connection, then derive the (shop, platform)
// pair core's booking-workflow functions are scoped by. Centralized here so
// each route's loader/action is a one-line call instead of repeating
// requireUserSession + getUserConnection + the 404 check.
export async function requireTenant(request: Request, connectionId: string) {
  const session = await requireUserSession(request);
  const connection = await getUserConnection(session.userId, connectionId);
  // A disconnected store (Settings › Integrations' "Disconnect") sets
  // status to "revoked" — treat it the same as not found, mirroring the
  // check core's verifySessionToken already does for the tenant-select
  // cookie, so the dashboard actually becomes unreachable.
  if (!connection || connection.status !== "active") {
    throw data("Store not found", { status: 404 });
  }
  return { userId: session.userId, connection, shop: connection.shop, platform: connection.platform };
}
