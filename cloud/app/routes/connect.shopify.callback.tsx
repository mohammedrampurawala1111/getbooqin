import { data, redirect } from "react-router";
import type { Route } from "./+types/connect.shopify.callback";
import {
  Data,
  Settings,
  ShopAlreadyConnectedError,
  connectShopifyStore,
  exchangeCodeForToken,
  isValidShopDomain,
  verifyCallbackHmac,
  verifyOAuthState,
} from "getbooqin-core";
import { getUserSession } from "~/session.server";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "";
  const code = url.searchParams.get("code") || "";
  const stateParam = url.searchParams.get("state") || "";

  if (!isValidShopDomain(shop) || !code || !verifyCallbackHmac(url.searchParams)) {
    throw data("Invalid OAuth callback.", { status: 400 });
  }

  const state = verifyOAuthState(stateParam);
  if (!state || state.shop !== shop) {
    throw data("This connect link has expired — start over from the dashboard.", { status: 400 });
  }

  // The signed state already proves who started this flow; also require the
  // browser to still be logged in as that same user, in case the session
  // changed mid-flow.
  const session = await getUserSession(request);
  if (!session || session.userId !== state.userId) {
    throw redirect("/login");
  }

  const { accessToken } = await exchangeCodeForToken({ shop, code });

  let connection;
  try {
    connection = await connectShopifyStore({ userId: state.userId, shop, accessToken });
  } catch (error) {
    if (error instanceof ShopAlreadyConnectedError) {
      throw data(`${shop} is already connected to a different GetBooqin account.`, { status: 409 });
    }
    throw error;
  }

  // Apply the pre-connection onboarding wizard's answers now that there's
  // finally a shop to attach them to (see ShopifyOAuthState.onboarding's
  // doc comment in core/src/platforms/shopify.ts for why this can't happen
  // any earlier). Absent for every other way of reaching this callback.
  if (state.onboarding) {
    const { presetId, businessName, businessEmail, businessPhone, timezone, resourceName, remindersOn } = state.onboarding;

    const settingsPatch: Record<string, string | boolean> = { reminder_enabled: !!remindersOn };
    if (businessName) settingsPatch.business_name = businessName;
    if (businessEmail) settingsPatch.business_email = businessEmail;
    if (businessPhone) settingsPatch.business_phone = businessPhone;
    if (timezone) settingsPatch.timezone = timezone;
    await Settings.setSettings(shop, "shopify", settingsPatch);

    if (presetId) {
      await Settings.applyPreset(shop, "shopify", presetId);
    }

    if (resourceName) {
      await Data.saveResource(
        shop,
        "shopify",
        {
          name: resourceName,
          title: "",
          email: "",
          phone: "",
          description: "",
          meeting_link: "",
          timezone: "",
          status: true,
          schedule: [],
          service_ids: [],
        },
        0
      );
    }
  }

  throw redirect(`/dashboard/${connection.id}`);
}
