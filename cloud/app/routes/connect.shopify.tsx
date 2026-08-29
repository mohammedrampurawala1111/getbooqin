import { Form, redirect } from "react-router";
import type { Route } from "./+types/connect.shopify";
import { buildAuthorizationUrl, isValidShopDomain, signOAuthState } from "getbooqin-core";
import { requireUserSession } from "~/session.server";
import { Field, Input } from "~/components/ui";

function getAppUrl(): string {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error("APP_URL is not set");
  return appUrl;
}

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
  });
  const redirectUri = `${getAppUrl()}/connect/shopify/callback`;
  const authorizationUrl = buildAuthorizationUrl({ shop, redirectUri, state });

  throw redirect(authorizationUrl);
}

export default function ConnectShopify({ actionData }: Route.ComponentProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-8">
      <div className="card w-full max-w-[400px] p-[26px]">
        <h1 className="page-title">Connect Shopify store</h1>
        {actionData?.error && <div className="alert-error mt-3">{actionData.error}</div>}
        <Form method="post" className="mt-5 flex flex-col gap-[14px]">
          <Field label="Shop domain">
            <Input type="text" name="shop" placeholder="your-store.myshopify.com" required />
          </Field>
          <button type="submit" className="btn-pri mt-1 justify-center">
            Connect
          </button>
        </Form>
      </div>
    </div>
  );
}
