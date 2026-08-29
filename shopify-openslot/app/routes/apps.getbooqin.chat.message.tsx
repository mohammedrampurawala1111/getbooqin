import type { ActionFunctionArgs } from "react-router";
import { proxyShop, getSettings } from "~/lib/proxy.server";
import { ChatFlow } from "getbooqin-core";
import { ok, fail, throttle, clientIp } from "~/lib/http.server";
import { GetBooqinError } from "getbooqin-core";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return fail(new GetBooqinError("getbooqin_method", "Method not allowed.", 405));

  try {
    const shop = await proxyShop(request);
    const settings = await getSettings(shop);
    if (!settings.chat_enabled) {
      throw new GetBooqinError("getbooqin_chat_disabled", "Chat is not available.", 403);
    }
    throttle(`chat_msg:${shop}:${clientIp(request)}`, 120);

    const body = await request.json();
    const result = await ChatFlow.respond(shop, "shopify", String(body.conversation || ""), String(body.value || ""));
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
