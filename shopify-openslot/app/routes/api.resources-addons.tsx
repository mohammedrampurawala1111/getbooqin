import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { Data } from "getbooqin-core";

/**
 * Backs the getbooqin-service-config Admin UI Extension's resource/add-on
 * pickers. GetBooqin's Resource/Addon registries live only in this app's own
 * database, not Shopify — an extension rendered on the product page has no
 * other way to list them. `authenticate.admin` here works the same way it
 * does for the embedded app's own routes: the extension presents its own
 * session token (Authorization: Bearer) instead of the embedded iframe's
 * cookie, and shopify-app-react-router accepts either.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [resources, addons] = await Promise.all([
    Data.resources(shop, "shopify", true),
    Data.addons(shop, "shopify", true),
  ]);

  return {
    resources: resources.map((r) => ({ id: r.id, name: r.name })),
    addons: addons.map((a) => ({ id: a.id, name: a.name })),
  };
}
