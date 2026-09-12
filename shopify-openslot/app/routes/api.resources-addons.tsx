import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { Data } from "getbooqin-core";

/**
 * Backs the getbooqin-service-config Admin UI Extension's resource picker.
 * GetBooqin's Resource registry lives only in this app's own database, not
 * Shopify — an extension rendered on the product page has no other way to
 * list it. `authenticate.admin` here works the same way it does for the
 * embedded app's own routes: the extension presents its own session token
 * (Authorization: Bearer) instead of the embedded iframe's cookie, and
 * shopify-app-react-router accepts either.
 *
 * It used to serve an `addons` list too, and the path still says so. The
 * add-on admin screens came out in Phase 1's trim — nothing can create an
 * add-on any more, so there is nothing to pick — but the extension's
 * shipped bundle reads `body.addons ?? []`, so omitting the key degrades
 * to an empty picker with no rebuild required. Renaming the route would
 * break that bundle, so the name stays until the extension is next built.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const resources = await Data.resources(shop, "shopify", true);

  return { resources: resources.map((r) => ({ id: r.id, name: r.name })) };
}
