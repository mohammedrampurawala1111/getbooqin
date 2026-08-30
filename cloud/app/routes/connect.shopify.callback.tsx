import { data, redirect } from "react-router";
import type { Route } from "./+types/connect.shopify.callback";
import {
  Data,
  Settings,
  ShopifyAdmin,
  ShopAlreadyConnectedError,
  connectShopifyStore,
  deleteConnection,
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

  // Shopify's own registered timezone (Settings -> General -> Store
  // details) is authoritative over the onboarding wizard's browser-guessed
  // one -- whoever clicked through the wizard isn't necessarily sitting in
  // the studio. Only available from here on, once there's finally an
  // access token to ask Shopify with; best-effort, so a failed lookup just
  // leaves whatever signal was already there.
  const shopTimezone = await ShopifyAdmin.fetchShopTimezone(shop, accessToken);

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
    const resolvedTimezone = shopTimezone || timezone;
    if (resolvedTimezone) settingsPatch.timezone = resolvedTimezone;
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
  } else if (shopTimezone) {
    // No wizard ran this time (e.g. reconnecting a shop that was set up
    // some other way) -- still worth applying the real timezone, but only
    // over the untouched "UTC" default, never over something a merchant
    // already set deliberately.
    const current = await Settings.getSettings(shop, "shopify");
    if (current.timezone === "UTC") {
      await Settings.setSettings(shop, "shopify", { timezone: shopTimezone });
    }
  }

  // Clean up the wizard's step-1 manual draft, if this OAuth round trip
  // carried one — the user started "Go live without Shopify" then connected
  // a real store instead, so the draft was never gone live and would
  // otherwise sit in Settings › Integrations forever as an empty
  // "Manual setup" row. Best-effort: a real Shopify connection now exists
  // either way, so this shouldn't block landing on it.
  if (state.draftConnectionId) {
    await deleteConnection(state.userId, state.draftConnectionId).catch(() => {});
  }

  throw redirect(`/dashboard/${connection.id}`);
}
