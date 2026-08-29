import type { LoaderFunctionArgs } from "react-router";
import { proxyShop, getSettings } from "~/lib/proxy.server";
import { ChatFlow } from "getbooqin-core";
import { ok, fail } from "~/lib/http.server";
import { GetBooqinError } from "getbooqin-core";

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const shop = await proxyShop(request);
    const settings = await getSettings(shop);
    if (!settings.chat_enabled) {
      throw new GetBooqinError("getbooqin_chat_disabled", "Chat is not available.", 403);
    }
    const result = await ChatFlow.resume(shop, "shopify", params.uid || "");
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
