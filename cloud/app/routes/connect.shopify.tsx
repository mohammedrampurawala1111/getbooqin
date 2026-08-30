import { Form, redirect } from "react-router";
import type { Route } from "./+types/connect.shopify";
import { buildAuthorizationUrl, isValidShopDomain, signOAuthState } from "getbooqin-core";
import { requireUserSession } from "~/session.server";
import { AlertError, Field, Input } from "~/components/ui";
import { LogoMark } from "~/components/onboarding";
import { getAppUrl } from "~/lib/env.server";

export const meta: Route.MetaFunction = () => [{ title: "Connect Shopify · GetBooqin" }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserSession(request);
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireUserSession(request);
  const form = await request.formData();
  const shop = String(form.get("shop") || "")
    .trim()
    .toLowerCase();

  if (!isValidShopDomain(shop)) {
    return { error: "Enter a valid *.myshopify.com domain." };
  }

  // Present only when this form is the finish action of the pre-connection
  // onboarding wizard (routes/onboarding.tsx) — it has no store yet to save
  // these answers to, so it carries them through the OAuth round trip
  // instead. A plain "+ Connect another store" submission from Settings
  // leaves these fields absent, so `onboarding` stays undefined below.
  const presetId = String(form.get("ob_preset") || "") || undefined;
  const businessName = String(form.get("ob_business_name") || "") || undefined;
  const businessEmail = String(form.get("ob_business_email") || "") || undefined;
  const businessPhone = String(form.get("ob_business_phone") || "") || undefined;
  const timezone = String(form.get("ob_timezone") || "") || undefined;
  const resourceName = String(form.get("ob_resource_name") || "") || undefined;
  const remindersOnRaw = form.get("ob_reminders_on");
  const hasOnboarding = [presetId, businessName, businessEmail, businessPhone, timezone, resourceName, remindersOnRaw].some(
    (v) => v !== undefined && v !== null
  );
  // The wizard's step 1 already created a manual draft Connection to save
  // progress against (see onboarding.tsx) — absent for every other caller
  // of this form (e.g. Settings' "+ Connect another store").
  const draftConnectionId = String(form.get("ob_draft_connection_id") || "") || undefined;

  const state = signOAuthState({
    userId: session.userId,
    shop,
    ...(hasOnboarding
      ? {
          onboarding: {
            presetId,
            businessName,
            businessEmail,
            businessPhone,
            timezone,
            resourceName,
            remindersOn: remindersOnRaw === "on",
          },
        }
      : {}),
    ...(draftConnectionId ? { draftConnectionId } : {}),
  });
  const redirectUri = `${getAppUrl()}/connect/shopify/callback`;
  const authorizationUrl = buildAuthorizationUrl({ shop, redirectUri, state });

  throw redirect(authorizationUrl);
}

// Reachable directly (Settings › Integrations' "+ Connect another store",
// onboarding's "Finish later" link) as well as via the wizard's own
// ShopifyConnectForm — a logo + way back so it doesn't read as a dead end
// when someone lands here on its own (UX audit's B3/R6 findings).
export default function ConnectShopify({ actionData }: Route.ComponentProps) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-8">
      <div className="card w-full max-w-[400px] p-[26px]">
        <a href="/dashboard" className="mb-4 flex w-fit items-center gap-[9px] no-underline hover:no-underline">
          <LogoMark size={28} />
          <span className="text-[14px] font-semibold text-ink">GetBooqin</span>
        </a>
        <h1 className="page-title">Connect Shopify store</h1>
        {actionData?.error && <AlertError className="mt-3">{actionData.error}</AlertError>}
        <Form method="post" className="mt-5 flex flex-col gap-[14px]">
          <Field label="Shop domain">
            <Input type="text" name="shop" placeholder="your-store.myshopify.com" required />
          </Field>
          <button type="submit" className="btn-pri mt-1 w-full justify-center">
            Connect
          </button>
        </Form>
        <a href="/dashboard" className="mt-4 flex items-center text-body text-muted max-md:min-h-[44px]">&larr; Back to dashboard</a>
      </div>
    </div>
  );
}
